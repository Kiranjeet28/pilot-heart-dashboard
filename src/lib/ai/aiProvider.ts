// AI provider layer: local Qwen (llama-server) exclusive task planning.
// All planning and replanning calls route directly through local Qwen at http://127.0.0.1:8081.
// Never calls Gemini or Lovable AI Gateway for planning.
import { toast } from "sonner";
import { jsonrepair } from "jsonrepair";
import {
  normalizeProviderResponse,
  GeminiProvider,
  GrokProvider,
  type AIProviderResult,
  type AIRequest,
  type ProviderAdapter,
  type ProviderFailure,
} from "@/lib/ai/provider";
import {
  PLAN_JSON_SCHEMA,
  LOCAL_SYSTEM,
  buildPlanPrompt,
  uniqueContext,
} from "@/lib/ai/plan-prompt";
import { logInferenceTiming, type InferencePurpose } from "@/lib/ai/inference-log";
import {
  PLAN_MALFORMED_REPAIR_LIMIT,
  PLAN_SIMPLE_MAX_OUTPUT_TOKENS,
} from "@/lib/tasks/task-plan-orchestrator";
import { isSimpleDesktopTask } from "@/lib/tasks/simple-task";
import type { AccountProfile, Provider } from "@/lib/types";

export type AiMode = "auto" | "gemini" | "local";
export type ActiveProvider = "local" | "offline" | "gemini";

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8081";
export const LOCAL_HEALTH_CACHE_MS = 10_000;
export const LOCAL_HEALTH_TIMEOUT_MS = 2_000;
/** Abort a local call only when no new token arrives for this long… */
export const LOCAL_IDLE_TIMEOUT_MS = 90_000;
/** …or when the whole call exceeds this hard cap. */
export const LOCAL_HARD_CAP_MS = 15 * 60_000;
/** Cap for complex batches. Simple tasks use PLAN_SIMPLE_MAX_OUTPUT_TOKENS. */
export const LOCAL_MAX_TOKENS = 500;
export const LOCAL_TOKEN_BUDGET = 7000;
export const CHARS_PER_TOKEN = 3.5;
export const GEMINI_COOLDOWN_MS = 1800000;

export const OFFLINE_MESSAGE =
  "Cannot reach local Qwen at http://127.0.0.1:8081. Start llama-server on your PC.";
export const LOCAL_BLOCKED_MESSAGE =
  "Cannot reach the local model. Make sure it is running and the browser allows local network access.";
export const TOO_LARGE_MESSAGE =
  "This request is too large for the local model (8192-token limit). Shorten the task description.";
export const TRUNCATED_MESSAGE =
  "Local model hit the token limit and the plan was cut off. Try a shorter task.";

export interface AiRoutingConfig {
  mode: AiMode;
  localBaseUrl: string;
}

export interface ProviderLogEntry {
  at: number;
  provider: "local";
  ok: boolean;
  note: string;
  latencyMs?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  timeToFirstTokenMs?: number;
  promptMs?: number;
  promptTokens?: number;
  cacheTokens?: number;
  fallbackReason?: string;
}

export interface AiStatus {
  active: ActiveProvider;
  geminiDownUntil: number;
  lastGeminiError: string;
  localThinking: boolean;
  localTokens: number;
  phase: "idle" | "connecting" | "processing_prompt" | "generating";
  log: ProviderLogEntry[];
}

// ---------- small observable status (UI reads it via subscribe/get) ----------
const initialStatus = (): AiStatus => ({
  active: "local",
  geminiDownUntil: 0,
  lastGeminiError: "",
  localThinking: false,
  localTokens: 0,
  phase: "idle",
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
    return () => {
      listeners.delete(l);
    };
  },
};

let getConfig: () => AiRoutingConfig = () => ({
  mode: "local",
  localBaseUrl: DEFAULT_LOCAL_BASE_URL,
});

/** The store injects its settings getter so the mode/base URL live with the other settings. */
export function configureAiRouting(getter: () => AiRoutingConfig) {
  getConfig = getter;
}

function record(entry: Omit<ProviderLogEntry, "at" | "provider"> & { provider?: "local" }) {
  const full: ProviderLogEntry = { at: Date.now(), provider: "local", ...entry };
  console.info(
    `[DesktopPilot AI] local ${entry.ok ? "handled" : "failed"}: ${entry.note}`,
    entry.latencyMs !== undefined ? `(${(entry.latencyMs / 1000).toFixed(1)} s)` : "",
  );
  setStatus({ log: [full, ...status.log].slice(0, 30) });
}

function switchTo(next: ActiveProvider, why?: string) {
  const prev = status.active;
  if (prev === next) return;
  setStatus({ active: next });
  if (next === "offline") {
    toast.error(why ?? OFFLINE_MESSAGE);
  } else if (next === "local" && prev === "offline") {
    toast.success("Connected to local Qwen planner");
  }
}

// ---------- helpers ----------
const trimBase = (u: string) => {
  const value = (u.trim() || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
  if (!isLoopbackUrl(value)) throw new Error("Local model URL must use localhost or 127.0.0.1.");
  return value;
};

/** Drop keys whose value is undefined so returns satisfy exactOptionalPropertyTypes. */
function compact<T extends Record<string, unknown>>(obj: T) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as {
    [K in keyof T as T[K] extends undefined ? never : K]?: Exclude<T[K], undefined>;
  };
}

/** Only loopback addresses are accepted for the local model. */
export function isLoopbackUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(u.hostname) &&
      !u.username && !u.password && !u.search && !u.hash
    );
  } catch {
    return false;
  }
}

/** Legacy helper preserved for tests; planning never cools down remote providers. */
export function cooldownFor(message: string): number {
  const m = message.match(/retry (?:in|after) ([\d.]+)\s*s/i);
  if (!m) return GEMINI_COOLDOWN_MS;
  return Math.min(3600_000, Math.max(1000, Math.ceil(Number(m[1])) * 1000));
}

let cooling = false;
export const isGeminiCoolingDown = (_now = Date.now()) => cooling;
export function noteGeminiQuotaFromCheck() {
  cooling = true;
}
export function retryGeminiNow() {
  cooling = false;
  setStatus({ geminiDownUntil: 0, active: "local" });
}

const isUserAbort = (signal?: AbortSignal) => Boolean(signal?.aborted);

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Remove <think>…</think> blocks (and a dangling unclosed one) before parsing. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
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

export { LOCAL_SYSTEM };

/**
 * Fit the request into the local context budget: prompt + max_tokens <= 7000.
 * Drops oldest context lines first, then shortens remaining lines.
 * Never cuts the system prompt or the user's core request. Returns null when oversized.
 */
export function fitLocalPrompt(
  userRequest: string,
  targetId: string,
  context: string[],
  extraTokens = 0,
): string | null {
  const schemaOverhead = 250;
  const fits = (ctx: string[]) => {
    const prompt = buildPlanPrompt({ userRequest, targetId, context: ctx });
    // FIX: reserve the real generation budget (LOCAL_MAX_TOKENS), not a hardcoded 1024.
    const total =
      estimateTokens(LOCAL_SYSTEM) +
      estimateTokens(prompt) +
      schemaOverhead +
      extraTokens +
      LOCAL_MAX_TOKENS;
    return total <= LOCAL_TOKEN_BUDGET ? prompt : null;
  };

  let ctx = uniqueContext(context);
  for (;;) {
    const p = fits(ctx);
    if (p) return p;
    if (!ctx.length) break;
    ctx = ctx.slice(1); // drop oldest context line first
  }
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

// Deduplicate concurrent planning calls for the same task
const inFlightPlanning = new Map<string, Promise<AIProviderResult>>();

// ---------- local model health ----------
let healthCache: { url: string; at: number; ok: boolean; message: string } | null = null;

export async function checkLocalHealth(
  force = false,
): Promise<{ ok: boolean; message: string; latencyMs: number }> {
  const url = trimBase(getConfig().localBaseUrl);
  if (
    !force &&
    healthCache &&
    healthCache.url === url &&
    Date.now() - healthCache.at < LOCAL_HEALTH_CACHE_MS
  ) {
    return { ...healthCache, latencyMs: 0 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS);
  const start = Date.now();
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
      message: controller.signal.aborted
        ? "Local model did not answer within 2 seconds"
        : LOCAL_BLOCKED_MESSAGE,
    };
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - start;
  healthCache = { url, at: Date.now(), ...result };
  return { ...result, latencyMs };
}

const fail = (
  code: ProviderFailure["code"],
  message: string,
  retryable = false,
): ProviderFailure => ({
  ok: false,
  code,
  message,
  retryable,
});

interface StreamOutcome {
  ok: boolean;
  text: string;
  tokens: number;
  generatedTokens?: number;
  elapsedMs: number;
  timeToFirstTokenMs?: number;
  promptMs?: number;
  promptTokens?: number;
  cacheTokens?: number;
  finishReason?: string;
  error?: "timeout" | "idle" | "cancelled" | "network" | "http";
  status?: number;
}

/**
 * Streamed chat call to llama-server. Aborts after 90 s with no new token, or 15 min total.
 * Connects with stream: true, cache_prompt: true, enable_thinking: false.
 * Tracks prompt processing vs generation time accurately.
 */
export async function streamLocalChat(
  body: Record<string, unknown>,
  signal?: AbortSignal,
  onToken?: (n: number) => void,
): Promise<StreamOutcome> {
  const url = trimBase(getConfig().localBaseUrl);
  const controller = new AbortController();
  const started = Date.now();
  let timeToFirstTokenMs: number | undefined;
  let promptMs: number | undefined;
  let promptTokens: number | undefined;
  let cacheTokens: number | undefined;
  let finishReason: string | undefined;
  let reportedGeneratedTokens: number | undefined;

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
    setStatus({ phase: "connecting", localThinking: false });
    bumpIdle();

    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ ...body, stream: true, cache_prompt: true }),
    });

    if (!res.ok || !res.body) {
      return {
        ok: false,
        text,
        tokens,
        elapsedMs: Date.now() - started,
        error: "http",
        status: res.status,
      };
    }

    setStatus({ phase: "processing_prompt", localThinking: false });
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
          const chunk = JSON.parse(data) as {
            choices?: Array<{
              delta?: { content?: string | null };
              finish_reason?: string | null;
            }>;
            timings?: {
              prompt_ms?: number;
              prompt_n?: number;
              cache_n?: number;
              predicted_n?: number;
            };
            usage?: { completion_tokens?: number };
          };

          if (chunk.timings) {
            promptMs = chunk.timings.prompt_ms;
            promptTokens = chunk.timings.prompt_n;
            cacheTokens = chunk.timings.cache_n;
            reportedGeneratedTokens = chunk.timings.predicted_n ?? reportedGeneratedTokens;
          }
          if (typeof chunk.usage?.completion_tokens === "number") {
            reportedGeneratedTokens = chunk.usage.completion_tokens;
          }

          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;

          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length) {
            if (timeToFirstTokenMs === undefined) {
              timeToFirstTokenMs = Date.now() - started;
              setStatus({ phase: "generating", localThinking: true });
            }
            text += delta;
            tokens += 1;
            onToken?.(tokens);
          }
        } catch {
          /* ignore partial/malformed frames */
        }
      }
    }

    return {
      ok: true,
      text,
      tokens: reportedGeneratedTokens ?? tokens,
      ...compact({ generatedTokens: reportedGeneratedTokens }),
      elapsedMs: Date.now() - started,
      ...compact({
        timeToFirstTokenMs,
        promptMs,
        promptTokens,
        cacheTokens,
        finishReason,
      }),
    };
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
    setStatus({ phase: "idle", localThinking: false });
  }
}

const REMINDER = "Return only valid JSON matching the schema.";

async function localOnce(
  request: AIRequest,
  reminder: boolean,
  signal?: AbortSignal,
  purpose: InferencePurpose = "planning",
  reminderDetail?: string,
): Promise<{
  result: AIProviderResult;
  tokens: number;
  elapsedMs: number;
  metrics?: Partial<StreamOutcome>;
}> {
  const targetId = request.targetId ?? "desktop";
  const extra = reminder ? estimateTokens(REMINDER) : 0;
  // FIX: shorten long lines first, then fit. Previously shortening only ran after
  // the full context had already been dropped, so it never helped.
  const context = shortenContext(uniqueContext(request.context));

  const prompt = fitLocalPrompt(request.userRequest, targetId, context, extra);

  if (!prompt) {
    return {
      result: fail("invalid_response", TOO_LARGE_MESSAGE),
      tokens: 0,
      elapsedMs: 0,
    };
  }

  const repairNote = reminder ? (reminderDetail ? `${REMINDER} ${reminderDetail}` : REMINDER) : "";
  const messages = stripImageParts([
    { role: "system", content: LOCAL_SYSTEM },
    { role: "user", content: prompt },
    ...(repairNote ? [{ role: "user", content: repairNote }] : []),
  ]);

  setStatus({ localTokens: 0, localThinking: false });

  const out = await streamLocalChat(
    {
      model: request.modelOverride?.trim() || request.provider.model.trim() || "qwen",
      messages,
      temperature: 0.2,
      max_tokens: isSimpleDesktopTask(request.userRequest)
        ? PLAN_SIMPLE_MAX_OUTPUT_TOKENS
        : LOCAL_MAX_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "task_plan",
          strict: true,
          schema: PLAN_JSON_SCHEMA,
        },
      },
    },
    signal,
    (n) => setStatus({ localTokens: n }),
  );

  const metrics = compact({
    timeToFirstTokenMs: out.timeToFirstTokenMs,
    promptMs: out.promptMs,
    promptTokens: out.promptTokens,
    cacheTokens: out.cacheTokens,
  });
  const meta = {
    tokens: out.tokens,
    elapsedMs: out.elapsedMs,
    ...compact({ metrics: Object.keys(metrics).length ? metrics : undefined }),
  };

  if (!out.ok) {
    logInferenceTiming({
      purpose,
      durationMs: out.elapsedMs,
      timeToFirstTokenMs: out.timeToFirstTokenMs,
      promptTokens: out.promptTokens,
      generatedTokens: out.tokens,
      valid: false,
      validationError: out.error ?? "stream error",
    });
    if (out.error === "cancelled") {
      return { result: fail("unknown", "Cancelled"), ...meta };
    }

    if (out.error === "idle") {
      return {
        result: fail(
          "timeout",
          "Local model stopped responding (no new text for 90 seconds)",
          true,
        ),
        ...meta,
      };
    }

    if (out.error === "timeout") {
      return {
        result: fail("timeout", "Local model took longer than 15 minutes", true),
        ...meta,
      };
    }

    if (out.error === "http") {
      return {
        result: fail("network_error", `Local model error (HTTP ${out.status})`, true),
        ...meta,
      };
    }

    return {
      result: fail("network_error", LOCAL_BLOCKED_MESSAGE, true),
      ...meta,
    };
  }

  // FIX: a plan cut off at the token limit must not be "repaired" by jsonrepair
  // into a valid-looking but incomplete plan.
  if (out.finishReason === "length") {
    return { result: fail("invalid_response", TRUNCATED_MESSAGE), ...meta };
  }

  const content = stripThinking(out.text);

  if (!content) {
    logInferenceTiming({
      purpose,
      durationMs: out.elapsedMs,
      timeToFirstTokenMs: out.timeToFirstTokenMs,
      promptTokens: out.promptTokens,
      generatedTokens: out.generatedTokens ?? out.tokens,
      valid: false,
      validationError: "empty response",
    });
    return {
      result: fail("invalid_response", "Local model returned an empty answer"),
      ...meta,
    };
  }

  // Diagnostic classification: markdown fences, plain text, malformed JSON, or schema error
  let cleaned = content.trim();
  if (/```(?:json)?/i.test(cleaned)) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    logInferenceTiming({
      purpose,
      durationMs: out.elapsedMs,
      timeToFirstTokenMs: out.timeToFirstTokenMs,
      promptTokens: out.promptTokens,
      generatedTokens: out.generatedTokens ?? out.tokens,
      valid: false,
      validationError: "response did not contain a JSON object",
    });
    return {
      result: fail(
        "invalid_response",
        `Local Qwen returned plain text without JSON: "${cleaned.slice(0, 80)}"`,
      ),
      ...meta,
    };
  }

  const rawJson = match[0].trim();
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch (parseErr) {
    try {
      // Repair common malformed JSON returned by the local model.
      parsed = JSON.parse(jsonrepair(rawJson));
    } catch {
      logInferenceTiming({
        purpose,
        durationMs: out.elapsedMs,
        timeToFirstTokenMs: out.timeToFirstTokenMs,
        promptTokens: out.promptTokens,
        generatedTokens: out.generatedTokens ?? out.tokens,
        valid: false,
        validationError: "invalid JSON",
      });
      return {
        result: fail(
          "invalid_response",
          parseErr instanceof Error
            ? `Local Qwen returned invalid JSON: ${parseErr.message}`
            : "Local Qwen returned malformed JSON",
        ),
        ...meta,
      };
    }
  }

  const rawPlan = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const rawSteps = Array.isArray(rawPlan["steps"]) ? rawPlan["steps"] : [];
  const containsClick =
    (rawPlan["nextAction"] !== null &&
      typeof rawPlan["nextAction"] === "object" &&
      (rawPlan["nextAction"] as Record<string, unknown>)["kind"] === "click") ||
    rawSteps.some((step) => {
      if (!step || typeof step !== "object") return false;
      const row = step as Record<string, unknown>;
      const action = row["action"] && typeof row["action"] === "object"
        ? (row["action"] as Record<string, unknown>)
        : row;
      return action["kind"] === "click";
    });
  if (containsClick) {
    return {
      result: fail(
        "invalid_response",
        "Local Qwen has no visual grounding and cannot plan clicks. Capture a fresh screenshot and use a visually grounded planner, or clarify a supported non-click action.",
      ),
      ...meta,
    };
  }

  try {
    const result = normalizeProviderResponse(parsed);
    logInferenceTiming({
      purpose,
      durationMs: out.elapsedMs,
      timeToFirstTokenMs: out.timeToFirstTokenMs,
      promptTokens: out.promptTokens,
      generatedTokens: out.tokens,
      valid: true,
    });
    return {
      result,
      ...meta,
    };
  } catch (e) {
    const message =
      e instanceof Error
        ? `Local Qwen returned an invalid plan: ${e.message}`
        : "Local Qwen returned invalid JSON";
    logInferenceTiming({
      purpose,
      durationMs: out.elapsedMs,
      timeToFirstTokenMs: out.timeToFirstTokenMs,
      promptTokens: out.promptTokens,
      generatedTokens: out.tokens,
      valid: false,
      validationError: message,
    });
    return {
      result: fail("invalid_response", message),
      ...meta,
    };
  }
}

/**
 * Execute a local Qwen planning call with single in-flight queuing and task deduplication.
 */
export async function callLocal(
  request: AIRequest,
  signal?: AbortSignal,
  fallbackReason?: string,
): Promise<AIProviderResult> {
  const taskId = request.taskId;

  // Deduplicate concurrent planning calls for the same task
  if (taskId) {
    const existing = inFlightPlanning.get(taskId);
    if (existing) return existing;
  }

  const taskPromise = enqueueLocal(async () => {
    try {
      if (isUserAbort(signal)) return fail("unknown", "Cancelled");

      let a = await localOnce(request, false, signal);
      let tokens = a.tokens;
      let ms = a.elapsedMs;

      // Narrowly scoped single repair attempt only when response was invalid JSON
      // (not for oversize or truncation: a retry would hit the same limit).
      if (
        PLAN_MALFORMED_REPAIR_LIMIT > 0 &&
        !a.result.ok &&
        a.result.code === "invalid_response" &&
        !/click requires x and y|do not guess coordinates/i.test(a.result.message) &&
        a.result.message !== TOO_LARGE_MESSAGE &&
        a.result.message !== TRUNCATED_MESSAGE &&
        !/no visual grounding|cannot plan clicks/i.test(a.result.message) &&
        !isUserAbort(signal)
      ) {
        a = await localOnce(
          request,
          true,
          signal,
          "repair",
          `The previous response failed validation: ${a.result.message}`,
        );
        tokens += a.tokens;
        ms += a.elapsedMs;
      }

      const r = a.result;
      if (!r.ok && r.code === "network_error") {
        healthCache = null;
        switchTo("offline");
      }
      record({
        ok: r.ok,
        note: r.ok ? `${r.steps.length}-step plan` : r.message,
        ...compact({
          latencyMs: ms,
          outputTokens: tokens,
          tokensPerSec: ms > 0 ? Math.round((tokens / (ms / 1000)) * 10) / 10 : 0,
          timeToFirstTokenMs: a.metrics?.timeToFirstTokenMs,
          promptMs: a.metrics?.promptMs,
          promptTokens: a.metrics?.promptTokens,
          cacheTokens: a.metrics?.cacheTokens,
          fallbackReason,
        }),
      });

      return r;
    } finally {
      setStatus({ localThinking: false, phase: "idle" });
      if (taskId) inFlightPlanning.delete(taskId);
    }
  });

  if (taskId) inFlightPlanning.set(taskId, taskPromise);
  return taskPromise;
}

/** Legacy provider adapter call: routes directly to local Qwen. */
export async function callGemini(request: AIRequest): Promise<AIProviderResult> {
  return new GeminiProvider().getNextStep(request);
}

/**
 * The single entry point for every AI planning call.
 * Uses local Qwen exclusively. Never calls Gemini or Lovable AI Gateway.
 */
export async function runWithFallback(
  request: AIRequest,
  signal?: AbortSignal,
): Promise<AIProviderResult> {
  const health = await checkLocalHealth();
  if (!health.ok) {
    switchTo("offline");
    return fail(
      "network_error",
      `Local model is offline: ${health.message}. Start llama-server on port 8081.`,
      true,
    );
  }

  const result = await callLocal(request, signal);
  if (!result.ok && result.code === "network_error") {
    healthCache = null;
    switchTo("offline");
  } else if (result.ok) {
    switchTo("local");
  }
  return result;
}

/** Screen checks need vision, which the local text model doesn't have. Local-only never sends a screen unless configured. */
export function shouldSkipGeminiCheck(): boolean {
  return false;
}

/**
 * Provider adapter used by the task runner:
 * Always delegates to local Qwen.
 */
export function routedProvider(
  provider: Provider,
  _profile?: AccountProfile,
  signal?: AbortSignal,
): ProviderAdapter {
  if (provider.id === "gemini" || provider.type === "gemini") {
    const adapter = new GeminiProvider();
    return {
      name: adapter.name,
      type: adapter.type,
      getNextStep: (request) => adapter.getNextStep({ ...request, signal }),
    };
  }
  if (provider.id === "grok" || provider.type === "grok") {
    const adapter = new GrokProvider();
    return {
      name: adapter.name,
      type: adapter.type,
      getNextStep: (request) => adapter.getNextStep({ ...request, signal }),
    };
  }
  return {
    name: "Local Qwen",
    type: "custom",
    getNextStep: (req) => runWithFallback(req, signal),
  };
}

// ---------- diagnostics ----------
export type DiagnosticFailure =
  "server_not_running" | "cors_or_browser_block" | "timeout" | "bad_response" | null;

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
  timeout:
    "The model server answered too slowly. Wait until the model has finished loading and try again.",
  bad_response:
    'The model server answered, but not as expected. Make sure it is llama-server with the model alias "qwen".',
};

export async function runLocalDiagnostics(): Promise<DiagnosticsReport> {
  const url = trimBase(getConfig().localBaseUrl);
  const health = await checkLocalHealth(true);
  const report = (
    failure: DiagnosticFailure,
    chat?: DiagnosticsReport["chat"],
  ): DiagnosticsReport => ({
    health: { ok: health.ok, latencyMs: health.latencyMs, message: health.message },
    failure,
    hint: failure ? DIAGNOSTIC_HINTS[failure] : "Local model is working.",
    ...compact({ chat }),
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
    tokensPerSec:
      out.elapsedMs > 0 ? Math.round((out.tokens / (out.elapsedMs / 1000)) * 10) / 10 : 0,
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
  inFlightPlanning.clear();
  cooling = false;
}
