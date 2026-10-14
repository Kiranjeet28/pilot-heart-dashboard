import { z } from "zod";
import { normalizeProviderResponse, type ProviderResult } from "@/lib/ai/provider";
import {
  PLAN_JSON_SCHEMA,
  LOCAL_SYSTEM,
  buildPlanPrompt as buildPrompt,
} from "@/lib/ai/plan-prompt";

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
  timeoutMs: z.number().int().min(1000).max(120000).optional().default(60000),
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

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "{}";
  const block = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const match = block.match(/\{[\s\S]*\}/);
  return match ? match[0] : block;
}

/**
 * Strip additionalProperties from JSON schemas if needed.
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

/**
 * Local-only task planning.
 * Routes directly to local llama-server running model alias "qwen".
 * Never calls Gemini or Lovable AI Gateway.
 */
export async function generateTaskPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  const rawBase = "http://127.0.0.1:8081";
  const baseUrl = rawBase.replace(/\/+$/, "");
  const endpoint = baseUrl.endsWith("/v1")
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  const model = "qwen";
  const timeoutMs = input.timeoutMs ?? 60000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.2,
        max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
        response_format: {
          type: "json_schema",
          json_schema: { name: "task_plan", strict: true, schema: PLAN_JSON_SCHEMA },
        },
        messages: [
          {
            role: "system",
            content: LOCAL_SYSTEM,
          },
          {
            role: "user",
            content: buildPrompt(input),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw Object.assign(
        new Error(`Local Qwen server returned HTTP ${response.status}. ${details.slice(0, 300)}`),
        {
          code: "local_model_error",
          status: 502,
        },
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ text?: string }>;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content;
    const rawText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => part.text ?? "").join("")
          : "";

    if (!rawText.trim()) {
      throw Object.assign(new Error("Local Qwen returned an empty plan."), {
        code: "invalid_response",
        status: 502,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(rawText));
    } catch {
      throw Object.assign(new Error("Local Qwen did not return valid JSON."), {
        code: "invalid_response",
        status: 502,
      });
    }

    try {
      return normalizeProviderResponse(parsed);
    } catch (error) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : "Local Qwen returned an invalid plan."),
        { code: "invalid_response", status: 502 },
      );
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw Object.assign(new Error("Local Qwen planning request timed out."), {
        code: "timeout",
        status: 504,
      });
    }

    throw Object.assign(
      new Error(
        `Cannot reach local Qwen at ${endpoint}. Check that llama-server is running on port 8081.`,
      ),
      { code: "local_model_unavailable", status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible export for any callers of generateGeminiTaskPlan. */
export const generateGeminiTaskPlan = generateTaskPlan;

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
      {
        ok: false,
        code: "rate_limited",
        message: "Too many planning requests. Try again shortly.",
      },
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
    const result = await generateTaskPlan(parsed.data);
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
        : code === "rate_limit"
          ? 429
          : code === "timeout"
            ? 504
            : 502;
    return Response.json({ ok: false, code, message }, { status });
  }
}
