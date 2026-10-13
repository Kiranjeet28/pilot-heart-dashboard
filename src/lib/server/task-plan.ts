import { z } from "zod";
import { normalizeProviderResponse, type ProviderResult } from "@/lib/ai/provider";

export interface TaskPlanRequestInput {
  taskId?: string | undefined;
  userRequest: string;
  targetId?: string | undefined;
  providerId?: string | undefined;
  profileId?: string | undefined;
  context?: string[] | undefined;
  modelOverride?: string | undefined;
  timeoutMs?: number | undefined;
}

const taskPlanRequestSchema = z.object({
  taskId: z.string().min(1).max(128).optional(),
  userRequest: z.string().min(1).max(4000),
  targetId: z.string().min(1).max(128).optional(),
  providerId: z.string().min(1).max(128).optional(),
  profileId: z.string().min(1).max(128).optional(),
  context: z.array(z.string().min(1).max(500)).max(12).optional().default([]),
  modelOverride: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(30000),
});

function getServerToken(): string | null {
  const token = process.env["DESKTOPPILOT_SERVER_TOKEN"]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Same-origin evidence policy: a browser request must positively prove it
 * originates from this app. Missing Origin/Referer and unknown fetch metadata
 * are treated as untrusted — never as proof of trust.
 */
function isSameOriginRequest(request: Request): boolean {
  const url = new URL(request.url);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;

  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  if (!originHeader && !refererHeader) return false;

  for (const candidate of [originHeader, refererHeader]) {
    if (!candidate) continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin !== url.origin) return false;
    } catch {
      return false;
    }
  }

  return true;
}

export function isAuthorizedRequest(request: Request): boolean {
  const authHeader =
    request.headers.get("authorization") ?? request.headers.get("x-desktoppilot-session");

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) return false;
    const provided = authHeader.slice(7).trim();
    const serverToken = getServerToken();
    return Boolean(serverToken) && provided.length > 0 && provided === serverToken;
  }

  return isSameOriginRequest(request);
}

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const rateBuckets = new Map<string, number[]>();

/** Sliding-window rate limiter, keyed by request origin (or a shared bucket when absent). */
export function isRateLimited(
  key: string,
  limit = RATE_LIMIT_MAX,
  windowMs = RATE_LIMIT_WINDOW_MS,
  now = Date.now(),
): boolean {
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (bucket.length >= limit) {
    rateBuckets.set(key, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return false;
}

// ---------- Lovable AI Gateway (server-side planning transport) ----------

const GATEWAY_CHAT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const LOVABLE_AIG_RUN_ID_HEADER = "X-Lovable-AIG-Run-ID";
const MAX_PLAN_TOKENS = 800;

/** Strict JSON schema the model must emit; verified again by responseSchema on the way out. */
const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "summary", "steps"],
  properties: {
    plan: { type: "array", maxItems: 12, items: { type: "string" } },
    summary: { type: "string" },
    steps: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "requiresApproval"],
        properties: {
          action: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "targetId", "description"],
            properties: {
              kind: {
                type: "string",
                enum: [
                  "focus_window",
                  "read_screen",
                  "click",
                  "type_text",
                  "key_press",
                  "wait",
                  "copy_selection",
                  "paste",
                ],
              },
              targetId: { type: "string" },
              description: { type: "string" },
              text: { type: "string" },
              x: { type: "integer" },
              y: { type: "integer" },
              keys: { type: "string" },
              durationMs: { type: "integer" },
              observationId: { type: "string" },
            },
          },
          requiresApproval: { type: "boolean" },
          verification: {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: {
                type: "string",
                enum: ["worker_ok", "screen_capture", "text_match", "clipboard"],
              },
              expectedText: { type: "string" },
              allowPartial: { type: "boolean" },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Gemini's native responseSchema is an OpenAPI subset that rejects
 * `additionalProperties`. Strip it for the direct call; strictness is still
 * enforced afterwards by server-side and client-side plan validation.
 */
export function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiResponseSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "additionalProperties" || key === "maxItems") continue;
      out[key] = toGeminiResponseSchema(value);
    }
    return out;
  }
  return schema;
}

const GEMINI_RESPONSE_SCHEMA = toGeminiResponseSchema(PLAN_JSON_SCHEMA);


function resolveGatewayModel(model?: string): string {
  const requested = (model ?? process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash").trim();
  if (requested.includes("/")) return requested;
  if (requested.startsWith("gemini")) return `google/${requested}`;
  return requested;
}

interface GatewayRequestError extends Error {
  code: string;
  status?: number;
}

function gatewayError(code: string, message: string, status?: number): GatewayRequestError {
  return Object.assign(new Error(message), { code, ...(status !== undefined ? { status } : {}) });
}

function gatewayCodeFor(status: number): string {
  if (status === 401) return "auth_failed";
  if (status === 402) return "insufficient_credits";
  if (status === 403) return "forbidden";
  if (status === 404) return "unavailable_model";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "network_error";
  return "provider_error";
}

async function extractGatewayErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown; message?: string };
    if (typeof data.message === "string" && data.message) return data.message;
    if (data.error && typeof data.error === "object") {
      const message = (data.error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  } catch {
    /* fall through to a generic message */
  }
  return `AI gateway error (HTTP ${res.status})`;
}

/** Run-ID wrapper: reuse gateway-issued run ids on follow-ups; never mint one. */
function createRunIdFetch() {
  let runId: string | undefined;
  return {
    getRunId: () => runId,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (runId && !headers.has(LOVABLE_AIG_RUN_ID_HEADER))
        headers.set(LOVABLE_AIG_RUN_ID_HEADER, runId);
      const response = await fetch(input, { ...init, headers });
      runId ??= response.headers.get(LOVABLE_AIG_RUN_ID_HEADER)?.trim() || undefined;
      return response;
    },
  };
}

/** Accumulate the streamed chat-completions deltas into the full text content. */
async function consumeSsePlan(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") content += delta;
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
  return content;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  const block = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const match = block.match(/\{[\s\S]*\}/);
  return match ? match[0] : cleanedFallback(block);
}

function cleanedFallback(raw: string): string {
  const normalized = raw.trim();
  if (!normalized) return "{}";
  if (normalized.startsWith("{") || normalized.startsWith("[")) return normalized;
  return JSON.stringify({ plan: [normalized], summary: normalized.slice(0, 200) });
}

function buildPrompt(input: TaskPlanRequestInput): string {
  const safeRequest = input.userRequest.trim();
  const targetLine = `Selected desktop target ID: ${input.targetId ?? "desktop"}. Every action's targetId MUST be exactly this value.`;
  const contextText = input.context?.length
    ? `\nContext:\n${input.context.map((item) => `- ${item}`).join("\n")}`
    : "";
  return [
    "Return only valid JSON with this exact shape:",
    "{",
    '  "plan": ["step 1 description", "step 2 description"],',
    '  "summary": "short summary",',
    '  "steps": [{ "action": { "kind": "read_screen", "targetId": "<selected target id>", "description": "inspect the desktop" }, "requiresApproval": false, "verification": { "kind": "screen_capture" } }]',
    "}",
    "Choose only safe desktop actions from this allowlist: focus_window, read_screen, click, type_text, key_press, wait, copy_selection, paste.",
    targetLine,
    `Task: ${safeRequest}${contextText}`,
    "Verification kinds: worker_ok and screen_capture are always allowed. Use text_match only when you also provide expectedText for text you know will appear on screen. Use clipboard only for copy_selection steps. Never invent verification evidence.",
    "Keep the plan bounded to at most 12 steps and realistic for DesktopPilot. Include verification for every step and avoid unsafe or destructive actions.",
    "The response must be parseable by JSON.parse without commentary or markdown fences.",
  ].join("\n");
}

// ---------- Direct Gemini fallback (local runs without the Lovable gateway) ----------

const GEMINI_DIRECT_URL = "https://generativelanguage.googleapis.com/v1beta/models";

function resolveDirectGeminiModel(model?: string): string {
  const requested = (model ?? process.env["GEMINI_MODEL"] ?? "gemini-2.5-flash").trim();
  if (requested.includes("/")) return requested.split("/").pop() ?? requested;
  return requested;
}

/** Call Gemini directly with the user's own key (GEMINI_API_KEY) — used for local runs. */
async function generateDirectGeminiPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) {
    throw gatewayError(
      "missing_credentials",
      "No AI key configured. Set GEMINI_API_KEY in your local .env (the built-in LOVABLE_API_KEY is only available in the Lovable preview).",
    );
  }
  const model = resolveDirectGeminiModel(input.modelOverride);
  const timeoutMs = input.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${GEMINI_DIRECT_URL}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: "You plan safe desktop automation steps for DesktopPilot. Respond only with JSON matching this JSON schema (at most 12 steps): " +
                  JSON.stringify(GEMINI_RESPONSE_SCHEMA),
              },
            ],
          },
          contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
          generationConfig: {
            temperature: 0.2,
            // Gemini 2.5 "thinking" counts against this budget and truncated plans.
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const message = await extractGatewayErrorMessage(response);
      throw gatewayError(gatewayCodeFor(response.status), message, response.status);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!rawText.trim()) {
      throw gatewayError("invalid_response", "Gemini returned an empty plan.", 502);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(rawText));
    } catch {
      throw gatewayError(
        "invalid_response",
        "The AI returned a response that was not valid JSON.",
        502,
      );
    }
    try {
      return normalizeProviderResponse(parsed);
    } catch (error) {
      throw gatewayError(
        "invalid_response",
        error instanceof Error ? error.message : "Malformed AI response",
        502,
      );
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    if (controller.signal.aborted) {
      throw gatewayError("timeout", "AI planning request timed out.", 504);
    }
    throw gatewayError(
      "network_error",
      error instanceof Error ? error.message : "AI planning request failed",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function generateGeminiTaskPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  const apiKey = process.env["LOVABLE_API_KEY"]?.trim();
  // A missing or placeholder gateway key means a local run: use the user's own
  // Gemini key directly instead of the Lovable gateway.
  if (!apiKey || apiKey === "your-key-here") {
    return generateDirectGeminiPlan(input);
  }
  const model = resolveGatewayModel(input.modelOverride);
  const timeoutMs = input.timeoutMs ?? 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { fetch: runIdFetch } = createRunIdFetch();
    const response = await runIdFetch(GATEWAY_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "Lovable-API-Key": apiKey,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: MAX_PLAN_TOKENS,
        ...(model.startsWith("google/") ? { temperature: 0.2 } : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: "task_plan", strict: true, schema: PLAN_JSON_SCHEMA },
        },
        messages: [
          {
            role: "system",
            content:
              "You plan safe desktop automation steps for DesktopPilot. Respond only with JSON matching this JSON schema (at most 12 steps): " +
                  JSON.stringify(GEMINI_RESPONSE_SCHEMA),
          },
          { role: "user", content: buildPrompt(input) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await extractGatewayErrorMessage(response);
      throw gatewayError(gatewayCodeFor(response.status), message, response.status);
    }

    const rawText = await consumeSsePlan(response);
    if (!rawText.trim()) {
      throw gatewayError("invalid_response", "The AI gateway returned an empty plan.", 502);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(rawText));
    } catch {
      throw gatewayError(
        "invalid_response",
        "The AI returned a response that was not valid JSON.",
        502,
      );
    }
    try {
      return normalizeProviderResponse(parsed);
    } catch (error) {
      throw gatewayError(
        "invalid_response",
        error instanceof Error ? error.message : "Malformed AI response",
        502,
      );
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      // Local runs sometimes carry a stale/invalid gateway key in .env — fall
      // back to the user's own Gemini key when the gateway rejects auth.
      if (
        (error as { code?: unknown }).code === "auth_failed" &&
        process.env["GEMINI_API_KEY"]?.trim()
      ) {
        return generateDirectGeminiPlan(input);
      }
      throw error;
    }
    if (controller.signal.aborted) {
      throw gatewayError("timeout", "AI planning request timed out.", 504);
    }
    throw gatewayError(
      "network_error",
      error instanceof Error ? error.message : "AI planning request failed",
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function handleTaskPlanRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { ok: false, code: "invalid_method", message: "POST is required." },
      { status: 405 },
    );
  }

  if (!isAuthorizedRequest(request)) {
    return Response.json(
      { ok: false, code: "unauthorized", message: "Authentication required." },
      { status: 401 },
    );
  }

  const bucketKey =
    request.headers.get("origin") ?? request.headers.get("referer") ?? "headerless-client";
  if (isRateLimited(bucketKey)) {
    return Response.json(
      { ok: false, code: "rate_limited", message: "Too many planning requests. Try again shortly." },
      { status: 429 },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json(
      { ok: false, code: "payload_too_large", message: "Request body exceeds the 64 KB limit." },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json(
      { ok: false, code: "invalid_request", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = taskPlanRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
      { status: 400 },
    );
  }

  try {
    const result = await generateGeminiTaskPlan(parsed.data);
    if (
      parsed.data.targetId &&
      result.steps.some((step) => step.action.targetId !== parsed.data.targetId)
    ) {
      return Response.json(
        {
          ok: false,
          code: "target_mismatch",
          message: "One or more generated steps target a desktop other than the selected target.",
        },
        { status: 400 },
      );
    }
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI planning request failed";
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "unknown";
    const errorStatus = (error as { status?: unknown })?.status;
    const status =
      typeof errorStatus === "number"
        ? errorStatus
        : code === "missing_credentials"
          ? 500
          : code === "rate_limit"
            ? 429
            : 502;
    return Response.json({ ok: false, code, message }, { status });
  }
}
