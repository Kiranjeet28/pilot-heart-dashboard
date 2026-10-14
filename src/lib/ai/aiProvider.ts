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

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8080";
export const GEMINI_COOLDOWN_MS = 5 * 60_000;
export const LOCAL_HEALTH_CACHE_MS = 10_000;
export const LOCAL_HEALTH_TIMEOUT_MS = 2_000;
export const LOCAL_TIMEOUT_MS = 300_000;
const MAX_COOLDOWN_MS = 60 * 60_000;

export const OFFLINE_MESSAGE =
  "Gemini unavailable and local model is offline. Start run-model.bat on your PC.";
export const LOCAL_BLOCKED_MESSAGE =
  "Cannot reach the local model. Make sure it is running and the browser allows local network access.";

export interface AiRoutingConfig {
  mode: AiMode;
  localBaseUrl: string;
}

export interface ProviderLogEntry {
  at: number;
  provider: "gemini" | "local";
  ok: boolean;
  note: string;
}

export interface AiStatus {
  active: ActiveProvider;
  geminiDownUntil: number;
  localThinking: boolean;
  log: ProviderLogEntry[];
}

// ---------- small observable status (UI reads it via subscribe/getStatus) ----------
let status: AiStatus = { active: "gemini", geminiDownUntil: 0, localThinking: false, log: [] };
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

function record(provider: "gemini" | "local", ok: boolean, note: string) {
  const entry = { at: Date.now(), provider, ok, note };
  console.info(`[DesktopPilot AI] ${provider} ${ok ? "handled" : "failed"}: ${note}`);
  setStatus({ log: [entry, ...status.log].slice(0, 30) });
}

function switchTo(next: ActiveProvider, why?: string) {
  const prev = status.active;
  if (prev === next) return;
  setStatus({ active: next });
  if (next === "local" && prev === "gemini")
    toast.warning(why ?? "Gemini limit reached, switched to local model");
  else if (next === "gemini" && prev !== "gemini") toast.success("Gemini is back — switched back from the local model");
  else if (next === "offline") toast.error(OFFLINE_MESSAGE);
}

// ---------- helpers ----------
const trimBase = (u: string) => (u.trim() || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");

/** Cooldown from a Retry-After style hint ("retry in 58s"), else the default 5 minutes. */
export function cooldownFor(message: string): number {
  const m = message.match(/retry (?:in|after) ([\d.]+)\s*s/i);
  if (!m) return GEMINI_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(1000, Math.ceil(Number(m[1]) * 1000)));
}

export const isGeminiCoolingDown = (now = Date.now()) => status.geminiDownUntil > now;

function isUserAbort(signal?: AbortSignal) {
  return Boolean(signal?.aborted);
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

const LOCAL_SYSTEM =
  "You plan safe desktop automation steps for DesktopPilot. Reply with JSON only, matching the given schema. At most 12 steps.";

async function localOnce(request: AIRequest, reminder: boolean, signal?: AbortSignal): Promise<AIProviderResult> {
  const url = trimBase(getConfig().localBaseUrl);
  // 8192-token context: keep the system prompt short and only the last 4 context lines.
  const prompt = buildPlanPrompt({
    userRequest: request.userRequest,
    targetId: request.targetId ?? "desktop",
    context: (request.context ?? []).slice(-4),
  });
  const messages = [
    { role: "system", content: LOCAL_SYSTEM },
    { role: "user", content: prompt },
    ...(reminder ? [{ role: "user", content: "Return valid JSON only." }] : []),
  ];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: "qwen",
        messages,
        temperature: 0.2,
        // A full plan needs more than 300 tokens; 1024 still fits the 300 s timeout on CPU.
        max_tokens: 1024,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: { name: "out", strict: true, schema: PLAN_JSON_SCHEMA },
        },
      }),
    });
    if (!res.ok) return fail("network_error", `Local model error (HTTP ${res.status})`, true);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) return fail("invalid_response", "Local model returned an empty answer");
    try {
      const m = content.match(/\{[\s\S]*\}/);
      return normalizeProviderResponse(JSON.parse(m ? m[0] : content));
    } catch (e) {
      return fail("invalid_response", e instanceof Error ? e.message : "Local model returned invalid JSON");
    }
  } catch {
    if (isUserAbort(signal)) return fail("unknown", "Cancelled");
    if (controller.signal.aborted) return fail("timeout", "Local model timed out after 300 seconds", true);
    return fail("network_error", LOCAL_BLOCKED_MESSAGE, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function callLocal(request: AIRequest, signal?: AbortSignal): Promise<AIProviderResult> {
  setStatus({ localThinking: true });
  try {
    let r = await localOnce(request, false, signal);
    if (!r.ok && r.code === "invalid_response" && !isUserAbort(signal)) r = await localOnce(request, true, signal);
    record("local", r.ok, r.ok ? `${r.steps.length}-step plan` : r.message);
    return r;
  } finally {
    setStatus({ localThinking: false });
  }
}

export async function callGemini(request: AIRequest): Promise<AIProviderResult> {
  const gemini = new GeminiProvider();
  let r = await gemini.getNextStep(request);
  if (!r.ok && r.code === "invalid_response") r = await gemini.getNextStep(request); // one retry
  if (!r.ok || r.steps.length === 0) {
    const message = r.ok ? "Gemini returned an empty plan" : r.message;
    record("gemini", false, message);
    return r.ok ? fail("invalid_response", message) : r;
  }
  record("gemini", true, `${r.steps.length}-step plan`);
  return r;
}

async function viaLocalOrOffline(request: AIRequest, geminiError: string | null, signal?: AbortSignal) {
  const health = await checkLocalHealth();
  if (!health.ok) {
    switchTo("offline");
    return fail(
      "network_error",
      geminiError === null ? `Local model is offline: ${health.message}` : OFFLINE_MESSAGE,
    );
  }
  switchTo("local", geminiError ? `Gemini unavailable (${geminiError.slice(0, 80)}), switched to local model` : undefined);
  return callLocal(request, signal);
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

/** Screen checks need vision, which the local text model doesn't have. */
export function shouldSkipGeminiCheck(): boolean {
  const { mode } = getConfig();
  return mode === "local" || (mode === "auto" && isGeminiCoolingDown());
}
export function noteGeminiQuotaFromCheck() {
  if (getConfig().mode === "auto") setStatus({ geminiDownUntil: Date.now() + GEMINI_COOLDOWN_MS });
}

/** Provider adapter used by the task runner: Gemini goes through the fallback layer. */
export function routedProvider(provider: Provider, profile?: AccountProfile): ProviderAdapter {
  if (provider.type !== "gemini") return createAIProvider(provider, profile);
  return { name: "Gemini (auto fallback)", type: "gemini", getNextStep: (req) => runWithFallback(req) };
}

/** Test-only reset. */
export function __resetAiStatus() {
  status = { active: "gemini", geminiDownUntil: 0, localThinking: false, log: [] };
  healthCache = null;
}
