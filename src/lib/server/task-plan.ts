import { z } from "zod";
import { normalizeProviderResponse, type ProviderResult } from "@/lib/ai/provider";
import {
  PLAN_JSON_SCHEMA,
  LOCAL_SYSTEM,
  buildPlanPrompt as buildPrompt,
} from "@/lib/ai/plan-prompt";

import {
  PLAN_CHUNK_MAX_OUTPUT_TOKENS,
  PLAN_MALFORMED_REPAIR_LIMIT,
  PLAN_SIMPLE_MAX_OUTPUT_TOKENS,
  TASK_DECOMPOSITION_SCHEMA,
  buildDecompositionPrompt,
  getReadyChunks,
  mergeChunkPlans,
  validateTaskDecomposition,
} from "@/lib/server/task-plan-orchestrator";
import { logInferenceTiming, type InferencePurpose } from "@/lib/ai/inference-log";
import { isSimpleDesktopTask } from "@/lib/tasks/simple-task";

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
  timeoutMs: z.number().int().min(1000).max(600000).optional().default(300000),
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
  const timeoutMs = input.timeoutMs ?? 300000;

  type LocalResponse = {
    choices?: Array<{
      message?: {
        content?: string | Array<{ text?: string }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
    };
    timings?: {
      prompt_n?: number;
      predicted_n?: number;
      prompt_ms?: number;
    };
  };

  async function requestJson(
    purpose: InferencePurpose,
    schemaName: string,
    schema: unknown,
    system: string,
    prompt: string,
    maxTokens: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let promptTokens: number | undefined;
    let generatedTokens: number | undefined;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          cache_prompt: true,
          temperature: 0.2,
          max_tokens: maxTokens,
          chat_template_kwargs: { enable_thinking: false },
          response_format: {
            type: "json_schema",
            json_schema: {
              name: schemaName,
              strict: true,
              schema,
            },
          },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        logInferenceTiming({
          purpose,
          durationMs: Date.now() - started,
          valid: false,
          validationError: `HTTP ${response.status}`,
        });
        throw Object.assign(
          new Error(`Local Qwen server returned HTTP ${response.status}. ${details.slice(0, 300)}`),
          { code: "local_model_error", status: 502 },
        );
      }

      const data = (await response.json()) as LocalResponse;
      promptTokens = data.usage?.prompt_tokens ?? data.timings?.prompt_n;
      generatedTokens = data.usage?.completion_tokens ?? data.timings?.predicted_n;
      const content = data.choices?.[0]?.message?.content;
      const rawText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => part.text ?? "").join("")
            : "";

      if (!rawText.trim()) {
        logInferenceTiming({
          purpose,
          durationMs: Date.now() - started,
          promptTokens,
          generatedTokens,
          valid: false,
          validationError: "empty response",
        });
        throw Object.assign(new Error("Local Qwen returned an empty response."), {
          code: "invalid_response",
          status: 502,
        });
      }

      try {
        const parsed = JSON.parse(extractJsonObject(rawText));
        logInferenceTiming({
          purpose,
          durationMs: Date.now() - started,
          promptTokens,
          generatedTokens,
          valid: true,
        });
        return parsed;
      } catch {
        logInferenceTiming({
          purpose,
          durationMs: Date.now() - started,
          promptTokens,
          generatedTokens,
          valid: false,
          validationError: "invalid JSON",
        });
        throw Object.assign(new Error("Local Qwen did not return valid JSON."), {
          code: "invalid_response",
          status: 502,
        });
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        throw error;
      }

      if (controller.signal.aborted) {
        logInferenceTiming({
          purpose,
          durationMs: Date.now() - started,
          promptTokens,
          generatedTokens,
          valid: false,
          validationError: "timeout",
        });
        throw Object.assign(new Error("Local Qwen planning request timed out."), {
          code: "timeout",
          status: 504,
        });
      }

      logInferenceTiming({
        purpose,
        durationMs: Date.now() - started,
        valid: false,
        validationError: "unreachable",
      });
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

  async function planDirect(planInput: TaskPlanRequestInput): Promise<ProviderResult> {
    const maxTokens = isSimpleDesktopTask(planInput.userRequest)
      ? PLAN_SIMPLE_MAX_OUTPUT_TOKENS
      : PLAN_CHUNK_MAX_OUTPUT_TOKENS;
    const prompt = buildPrompt(planInput);
    let rawPlan = await requestJson(
      "planning",
      "task_plan",
      PLAN_JSON_SCHEMA,
      LOCAL_SYSTEM,
      prompt,
      maxTokens,
    );

    try {
      return normalizeProviderResponse(rawPlan);
    } catch (firstError) {
      const details = firstError instanceof Error ? firstError.message : "invalid plan";
      logInferenceTiming({
        purpose: "planning",
        durationMs: 0,
        valid: false,
        validationError: details,
      });
      if (PLAN_MALFORMED_REPAIR_LIMIT < 1 || /click requires x and y|do not guess coordinates/i.test(details)) {
        throw Object.assign(new Error(details), { code: "invalid_response", status: 502 });
      }
      rawPlan = await requestJson(
        "repair",
        "task_plan",
        PLAN_JSON_SCHEMA,
        LOCAL_SYSTEM,
        `${prompt}\nRepair the previous JSON. Field errors: ${details}`,
        maxTokens,
      );
      try {
        return normalizeProviderResponse(rawPlan);
      } catch (secondError) {
        const message = secondError instanceof Error ? secondError.message : details;
        logInferenceTiming({
          purpose: "repair",
          durationMs: 0,
          valid: false,
          validationError: message,
        });
        throw Object.assign(new Error(message), {
          code: "invalid_response",
          status: 502,
        });
      }
    }
  }

  // Simple tasks: one planner request. Orchestration batches handle any follow-up.
  if (isSimpleDesktopTask(input.userRequest)) {
    return planDirect(input);
  }

  // First, split a complex request into a validated dependency graph.
  const decompositionRaw = await requestJson(
    "decomposition",
    "task_decomposition",
    TASK_DECOMPOSITION_SCHEMA,
    [
      "You are a task decomposition planner.",
      "Return only JSON matching the provided schema.",
      "Split the user's desktop task into small, independently plannable chunks.",
      "Use dependencies only when a chunk requires another chunk first.",
      "Create no more than 8 chunks.",
      "Do not execute actions or invent screen coordinates.",
    ].join(" "),
    buildDecompositionPrompt(input),
    400,
  );

  let decomposition;
  try {
    decomposition = validateTaskDecomposition(decompositionRaw);
  } catch (error) {
    throw Object.assign(
      new Error(
        error instanceof Error
          ? `Invalid task decomposition: ${error.message}`
          : "Local Qwen returned an invalid task decomposition.",
      ),
      { code: "invalid_response", status: 502 },
    );
  }

  const completedIds = new Set<string>();
  const resultsById = new Map<string, ProviderResult>();
  const orderedPlans: Array<{
    chunkId: string;
    result: ProviderResult;
  }> = [];

  // llama-server handles one request at a time — plan ready chunks sequentially.
  while (completedIds.size < decomposition.chunks.length) {
    const readyChunks = getReadyChunks(decomposition.chunks, completedIds, new Set<string>());

    if (readyChunks.length === 0) {
      throw Object.assign(new Error("No runnable chunks remain in the task dependency graph."), {
        code: "invalid_response",
        status: 502,
      });
    }

    for (const chunk of readyChunks) {
      const dependencyContext = chunk.dependsOn.map((dependencyId) => {
        const dependencyResult = resultsById.get(dependencyId);

        if (!dependencyResult) {
          throw new Error(`Missing completed planning dependency: ${dependencyId}`);
        }

        return [
          `Completed planning dependency: ${dependencyId}`,
          `Dependency summary: ${dependencyResult.summary}`,
        ].join("\n");
      });

      const chunkInput: TaskPlanRequestInput = {
        ...input,
        userRequest: chunk.description,
        context: [
          ...(input.context ?? []),
          `Original user task: ${input.userRequest}`,
          `Current chunk ID: ${chunk.id}`,
          `Current chunk objective: ${chunk.description}`,
          ...dependencyContext,
        ],
      };

      const result = await planDirect(chunkInput);
      const item = { chunkId: chunk.id, result };
      resultsById.set(item.chunkId, item.result);
      completedIds.add(item.chunkId);
      orderedPlans.push(item);
    }
  }

  try {
    return mergeChunkPlans(orderedPlans);
  } catch (error) {
    throw Object.assign(
      new Error(error instanceof Error ? error.message : "Unable to combine the chunk plans."),
      { code: "invalid_response", status: 502 },
    );
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
