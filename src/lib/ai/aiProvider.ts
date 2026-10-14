// AI provider layer: Gemini first, automatic fallback to a local llama.cpp model.
// runWithFallback is the single entry point for every AI planning call in the app.
// The Gemini key stays server-side (/api/tasks/plan). The local model is called from the
// browser because it only listens on the user's own PC.
import { toast } from "sonner";
import {
  GeminiProvider,
  createAIProvider,
  normalizeProviderResponse,
  type AIProviderResult,
  type AIRequest,
  type ProviderAdapter,
  type ProviderFailure,
} from "@/lib/ai/provider";
import { PLAN_JSON_SCHEMA, buildPlanPrompt } from "@/lib/ai/plan-prompt";
import type { AccountProfile, Provider } from "@/lib/types";

export type AiMode = "auto" | "gemini" | "local";
export type ActiveProvider = "gemini" | "local" | "offline";

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8081";
export const GEMINI_COOLDOWN_MS = 5 * 60_000;
export const LOCAL_HEALTH_CACHE_MS = 10_000;
export const LOCAL_HEALTH_TIMEOUT_MS = 2_000;
/** Abort a local call only when no new token arrives for this long… */
export const LOCAL_IDLE_TIMEOUT_MS = 90_000;
/** …or when the whole call exceeds this hard cap. */
export const LOCAL_HARD_CAP_MS = 15 * 60_000;
export const LOCAL_MAX_TOKENS = 1024;
export const LOCAL_TOKEN_BUDGET = 7000;
export const CHARS_PER_TOKEN = 3.5;
const MAX_COOLDOWN_MS = 60 * 60_000;

export const OFFLINE_MESSAGE =
  "Gemini unavailable and local model is offline. Start run-model.bat on your PC.";
export const LOCAL_BLOCKED_MESSAGE =
  "Cannot reach the local model. Make sure it is running and the browser allows local network access.";
export const TOO_LARGE_MESSAGE =
  "This request is too large for the local model (8192-token limit). Shorten the task description.";

export interface AiRoutingConfig {
  mode: AiMode;
  localBaseUrl: string;
}

export interface ProviderLogEntry {
  at: number;
  provider: "gemini" | "local";
  ok: boolean;
  note: string;
  latencyMs?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  fallbackReason?: string;
}

export interface AiStatus {
  active: ActiveProvider;
  geminiDownUntil: number;
  localThinking: boolean;
  /** Tokens streamed so far by the in-flight local call. */
  localTokens: number;
  log: ProviderLogEntry[];
}

// ---------- small observable status (UI reads it via subscribe/get) ----------
const initialStatus = (): AiStatus => ({
  active: "gemini",
  geminiDownUntil: 0,
  localThinking: false,
  localTokens: 0,
  log: [],
});
let status: AiStatus = initialStatus();
const listeners = new Set<() => void>();
function setStatus(p: Partial<AiStatus>) {
  status = { ...status, ...p };
  listeners.forEach((l) => l());
}
export const aiStatus = {
  get: () => status,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

let getConfig: () => AiRoutingConfig = () => ({ mode: "auto", localBaseUrl: DEFAULT_LOCAL_BASE_URL });
/** The store injects its settings getter so the mode/base URL live with the other settings. */
export function configureAiRouting(getter: () => AiRoutingConfig) {
  getConfig = getter;
}

function record(entry: Omit<ProviderLogEntry, "at">) {
  const full = { at: Date.now(), ...entry };
  console.info(
    `[DesktopPilot AI] ${entry.provider} ${entry.ok ? "handled" : "failed"}: ${entry.note}`,
    entry.latencyMs !== undefined ? `(${(entry.latencyMs / 1000).toFixed(1)} s)` : "",
  );
  setStatus({ log: [full, ...status.log].slice(0, 30) });
}

function switchTo(next: ActiveProvider, why?: string) {
  const prev = status.active;
  if (prev === next) return;
  setStatus({ active: next });
  if (next === "local" && prev === "gemini")
    toast.warning(why ?? "Gemini limit reached, switched to local model");
  else if (next === "gemini" && prev !== "gemini")
    toast.success("Gemini is back — switched back from the local model");
  else if (next === "offline") toast.error(OFFLINE_MESSAGE);
}

// ---------- helpers ----------
const trimBase = (u: string) => (u.trim() || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");

/** Only loopback addresses are accepted for the local model. */
export function isLoopbackUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Cooldown from a Retry-After style hint ("retry in 58s"), else the default 5 minutes. */
export function cooldownFor(message: string): number {
  const m = message.match(/retry (?:in|after) ([\d.]+)\s*s/i);
  if (!m) return GEMINI_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(1000, Math.ceil(Number(m[1])) * 1000));
}

export const isGeminiCoolingDown = (now = Date.now()) => status.geminiDownUntil > now;

/** "Retry Gemini now": clear the cooldown so the next call tries Gemini first. */
export function retryGeminiNow() {
  setStatus({ geminiDownUntil: 0, ...(status.active !== "gemini" ? { active: "gemini" as const } : {}) });
}

const isUserAbort = (signal?: AbortSignal) => Boolean(signal?.aborted);

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Remove <think>…</think> blocks (and a dangling unclosed one) before parsing. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

type ChatPart = { type: string; text?: string; [k: string]: unknown };
type ChatMessage = { role: string; content: string | ChatPart[] };

/** The local model is text-only: drop every image part and keep only the text. */
export function stripImageParts(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n"),
  }));
}

// System prompt is first and byte-identical on every call so llama.cpp's prompt cache can reuse it.
export const LOCAL_SYSTEM =
  "You plan safe desktop automation steps for DesktopPilot. Reply with JSON only, matching the given schema. At most 12 steps.";

/**
 * Fit the request into the local context budget: prompt + max_tokens <= 7000.
 * Drop the oldest context lines first, then shorten the remaining ones.
 * Never cuts the system prompt or the user's request. Returns null when it cannot fit.
 */
export function fitLocalPrompt(
  userRequest: string,
  targetId: string,
  context: string[],
  extraTokens = 0,
): string | null {
  const fits = (ctx: string[]) => {
    const prompt = buildPlanPrompt({ userRequest, targetId, context: ctx });
    const total = estimateTokens(LOCAL_SYSTEM) + estimateTokens(prompt) + extraTokens + LOCAL_MAX_TOKENS;
    return total <= LOCAL_TOKEN_BUDGET ? prompt : null;
  };
  let ctx = [...context];
  for (;;) {
    const p = fits(ctx);
    if (p) return p;
    if (!ctx.length) break;
    ctx = ctx.slice(1); // drop oldest first
  }
  // Still too big with no history: shorten observation text is no longer possible.
  return null;
}
/** Shorten observation/history lines once before dropping them entirely. */
function shortenContext(context: string[]) {
  return context.map((c) => (c.length > 200 ? `${c.slice(0, 197)}...` : c));
}

// ---------- single local request at a time ----------
let localQueue: Promise<unknown> = Promise.resolve();
/** Run local calls strictly one after another (llama-server handles one request). */
export function enqueueLocal<T>(job: () => Promise<T>): Promise<T> {
  const run = localQueue.then(job, job);
  localQueue = run.catch(() => undefined);
  return run;
}

// ---------- local model ----------
let healthCache: { url: string; at: number; ok: boolean; message: string } | null = null;

export async function checkLocalHealth(force = false): Promise<{ ok: boolean; message: string }> {
  const url = trimBase(getConfig().localBaseUrl);
  if (!force && healthCache && healthCache.url === url && Date.now() - healthCache.at < LOCAL_HEALTH_CACHE_MS)
    return healthCache;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS);
  let result: { ok: boolean; message: string };
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    result =
      res.ok && body?.status === "ok"
        ? { ok: true, message: "Local model is ready" }
        : { ok: false, message: `Local model not ready (${body?.status ?? `HTTP ${res.status}`})` };
  } catch {
    result = {
      ok: false,
      message: controller.signal.aborted ? "Local model did not answer within 2 seconds" : LOCAL_BLOCKED_MESSAGE,
    };
  } finally {
    clearTimeout(timer);
  }
  healthCache = { url, at: Date.now(), ...result };
  return result;
}

const fail = (code: ProviderFailure["code"], message: string, retryable = false): ProviderFailure => ({
  ok: false,
  code,
  message,
  retryable,
});

interface StreamOutcome {
  ok: boolean;
  text: string;
  tokens: number;
  elapsedMs: number;
  error?: "timeout" | "idle" | "cancelled" | "network" | "http";
  status?: number;
}

/**
 * Streamed chat call to llama-server. Aborts after 90 s with no new token, or 15 min total.
 * reasoning_content deltas are ignored; only content is collected.
 */
export async function streamLocalChat(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onToken?: (n: number) => void,
): Promise<StreamOutcome> {
  const url = trimBase(getConfig().localBaseUrl);
  const controller = new AbortController();
  const started = Date.now();
  let reason: StreamOutcome["error"];
  const onAbort = () => {
    reason = "cancelled";
    controller.abort();
  };
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();
  const hard = setTimeout(() => {
    reason = "timeout";
    controller.abort();
  }, LOCAL_HARD_CAP_MS);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const bumpIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      reason = "idle";
      controller.abort();
    }, LOCAL_IDLE_TIMEOUT_MS);
  };
  let text = "";
  let tokens = 0;
  try {
    bumpIdle();
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ ...body, stream: true, cache_prompt: true }),
    });
    if (!res.ok || !res.body)
      return { ok: false, text, tokens, elapsedMs: Date.now() - started, error: "http", status: res.status };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length) {
            text += delta;
            tokens += 1;
            onToken?.(tokens);
          }
        } catch {
          /* ignore partial/malformed frames */
        }
      }
    }
    return { ok: true, text, tokens, elapsedMs: Date.now() - started };
  } catch {
    return {
      ok: false,
      text,
      tokens,
      elapsedMs: Date.now() - started,
      error: reason ?? "network",
    };
  } finally {
    clearTimeout(hard);
    if (idle) clearTimeout(idle);
    signal?.removeEventListener("abort", onAbort);
  }
}

const REMINDER = "Return only valid JSON matching the schema.";

async function localOnce(
  request: AIRequest,
  reminder: boolean,
  signal?: AbortSignal,
): Promise<{ result: AIProviderResult; tokens: number; elapsedMs: number }> {
  const targetId = request.targetId ?? "desktop";
  const extra = reminder ? estimateTokens(REMINDER) : 0;
  const context = request.context ?? [];
  const prompt =
    fitLocalPrompt(request.userRequest, targetId, context, extra) ??
    fitLocalPrompt(request.userRequest, targetId, shortenContext(context), extra);
  if (!prompt) return { result: fail("invalid_response", TOO_LARGE_MESSAGE), tokens: 0, elapsedMs: 0 };
  const messages = stripImageParts([
    { role: "system", content: LOCAL_SYSTEM },
    { role: "user", content: prompt },
    ...(reminder ? [{ role: "user", content: REMINDER }] : []),
  ]);
  setStatus({ localTokens: 0 });
  const out = await streamLocalChat(
    {
      model: "qwen",
      messages,
      temperature: 0.2,
      max_tokens: LOCAL_MAX_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: { name: "out", strict: true, schema: PLAN_JSON_SCHEMA },
      },
    },
    signal,
    (n) => setStatus({ localTokens: n }),
  );
  const meta = { tokens: out.tokens, elapsedMs: out.elapsedMs };
  if (!out.ok) {
    if (out.error === "cancelled") return { result: fail("unknown", "Cancelled"), ...meta };
    if (out.error === "idle")
      return { result: fail("timeout", "Local model stopped responding (no new text for 90 seconds)", true), ...meta };
    if (out.error === "timeout")
      return { result: fail("timeout", "Local model took longer than 15 minutes", true), ...meta };
    if (out.error === "http")
      return { result: fail("network_error", `Local model error (HTTP ${out.status})`, true), ...meta };
    return { result: fail("network_error", LOCAL_BLOCKED_MESSAGE, true), ...meta };
  }
  const content = stripThinking(out.text);
  if (!content) return { result: fail("invalid_response", "Local model returned an empty answer"), ...meta };
  try {
    const m = content.match(/\{[\s\S]*\}/);
    // Same Zod validation as Gemini plans; the store then runs normalizeProviderPlan + validateAction.
    return { result: normalizeProviderResponse(JSON.parse(m ? m[0] : content)), ...meta };
  } catch (e) {
    return {
      result: fail("invalid_response", e instanceof Error ? e.message : "Local model returned invalid JSON"),
      ...meta,
    };
  }
}

export async function callLocal(
  request: AIRequest,
  signal?: AbortSignal,
  fallbackReason?: string,
): Promise<AIProviderResult> {
  return enqueueLocal(async () => {
    if (isUserAbort(signal)) return fail("unknown", "Cancelled");
    setStatus({ localThinking: true, localTokens: 0 });
    try {
      let a = await localOnce(request, false, signal);
      let tokens = a.tokens;
      let ms = a.elapsedMs;
      if (!a.result.ok && a.result.code === "invalid_response" && a.result.message !== TOO_LARGE_MESSAGE && !isUserAbort(signal)) {
        a = await localOnce(request, true, signal);
        tokens += a.tokens;
        ms += a.elapsedMs;
      }
      const r = a.result;
      record({
        provider: "local",
        ok: r.ok,
        note: r.ok ? `${r.steps.length}-step plan` : r.message,
        latencyMs: ms,
        outputTokens: tokens,
        tokensPerSec: ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : 0,
        ...(fallbackReason ? { fallbackReason } : {}),
      });
      return r;
    } finally {
      setStatus({ localThinking: false });
    }
  });
}

export async function callGemini(request: AIRequest): Promise<AIProviderResult> {
  const started = Date.now();
  const gemini = new GeminiProvider();
  let r = await gemini.getNextStep(request);
  if (!r.ok && r.code === "invalid_response") r = await gemini.getNextStep(request); // one retry
  const latencyMs = Date.now() - started;
  if (!r.ok || r.steps.length === 0) {
    const message = r.ok ? "Gemini returned an empty plan" : r.message;
    record({ provider: "gemini", ok: false, note: message, latencyMs });
    return r.ok ? fail("invalid_response", message) : r;
  }
  record({ provider: "gemini", ok: true, note: `${r.steps.length}-step plan`, latencyMs });
  return r;
}

async function viaLocalOrOffline(request: AIRequest, geminiError: string | null, signal?: AbortSignal) {
  const health = await checkLocalHealth();
  if (!health.ok) {
    switchTo("offline");
    return fail(
      "network_error",
      geminiError === null && getConfig().mode === "local" ? `Local model is offline: ${health.message}` : OFFLINE_MESSAGE,
    );
  }
  switchTo(
    "local",
    geminiError ? `Gemini unavailable (${geminiError.slice(0, 80)}), switched to local model` : undefined,
  );
  const reason =
    geminiError ?? (getConfig().mode === "local" ? undefined : "Gemini cooling down after an earlier failure");
  return callLocal(request, signal, reason);
}

/** The single entry point for every AI planning call. */
export async function runWithFallback(request: AIRequest, signal?: AbortSignal): Promise<AIProviderResult> {
  const { mode } = getConfig();
  if (mode === "local") return viaLocalOrOffline(request, null, signal);
  if (mode === "auto" && isGeminiCoolingDown()) return viaLocalOrOffline(request, null, signal);

  const r = await callGemini(request);
  if (r.ok) {
    setStatus({ geminiDownUntil: 0 });
    switchTo("gemini");
    return r;
  }
  if (mode === "gemini" || isUserAbort(signal)) return r;
  setStatus({ geminiDownUntil: Date.now() + cooldownFor(r.message) });
  return viaLocalOrOffline(request, r.message, signal);
}

/** Screen checks need vision, which the local text model doesn't have. Local-only never sends a screen. */
export function shouldSkipGeminiCheck(): boolean {
  const { mode } = getConfig();
  return mode === "local" || (mode === "auto" && isGeminiCoolingDown());
}
export function noteGeminiQuotaFromCheck() {
  if (getConfig().mode === "auto") setStatus({ geminiDownUntil: Date.now() + GEMINI_COOLDOWN_MS });
}

/** Provider adapter used by the task runner: Gemini goes through the fallback layer. */
export function routedProvider(
  provider: Provider,
  profile?: AccountProfile,
  signal?: AbortSignal,
): ProviderAdapter {
  if (provider.type !== "gemini") return createAIProvider(provider, profile);
  return {
    name: "Gemini (auto fallback)",
    type: "gemini",
    getNextStep: (req) => runWithFallback(req, signal),
  };
}

// ---------- diagnostics ----------
export type DiagnosticFailure =
  | "server_not_running"
  | "cors_or_browser_block"
  | "timeout"
  | "bad_response"
  | null;

export interface DiagnosticsReport {
  health: { ok: boolean; latencyMs: number; message: string };
  chat?: { ok: boolean; latencyMs: number; tokens: number; tokensPerSec: number; reply: string };
  failure: DiagnosticFailure;
  hint: string;
}

export const DIAGNOSTIC_HINTS: Record<Exclude<DiagnosticFailure, null>, string> = {
  server_not_running:
    "The model server isn't answering. Start run-model.bat on your PC and check the address and port.",
  cors_or_browser_block:
    "Allow local network access for this site in the browser's site settings, and make sure the model server is running.",
  timeout: "The model server answered too slowly. Wait until the model has finished loading and try again.",
  bad_response:
    "The model server answered, but not as expected. Make sure it is llama-server with the model alias \"qwen\".",
};

export async function runLocalDiagnostics(): Promise<DiagnosticsReport> {
  const url = trimBase(getConfig().localBaseUrl);
  const t0 = Date.now();
  const health = await checkLocalHealth(true);
  const healthLatency = Date.now() - t0;
  const report = (failure: DiagnosticFailure, chat?: DiagnosticsReport["chat"]): DiagnosticsReport => ({
    health: { ok: health.ok, latencyMs: healthLatency, message: health.message },
    ...(chat ? { chat } : {}),
    failure,
    hint: failure ? DIAGNOSTIC_HINTS[failure] : "Local model is working.",
  });
  if (!health.ok) {
    if (health.message.includes("2 seconds")) return report("timeout");
    if (health.message.startsWith("Local model not ready")) return report("bad_response");
    // A no-cors request succeeds when the server is up but the browser blocks reading it.
    try {
      await fetch(`${url}/health`, { mode: "no-cors" });
      return report("cors_or_browser_block");
    } catch {
      return report("server_not_running");
    }
  }
  const out = await enqueueLocal(() =>
    streamLocalChat({
      model: "qwen",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 8,
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
  );
  const chat = {
    ok: out.ok && stripThinking(out.text).length > 0,
    latencyMs: out.elapsedMs,
    tokens: out.tokens,
    tokensPerSec: out.elapsedMs > 0 ? Math.round((out.tokens / (out.elapsedMs / 1000)) * 10) / 10 : 0,
    reply: stripThinking(out.text).slice(0, 40),
  };
  if (chat.ok) return report(null, chat);
  if (out.error === "idle" || out.error === "timeout") return report("timeout", chat);
  if (out.error === "network") return report("cors_or_browser_block", chat);
  return report("bad_response", chat);
}

/** Test-only reset. */
export function __resetAiStatus() {
  status = initialStatus();
  healthCache = null;
  localQueue = Promise.resolve();
}
