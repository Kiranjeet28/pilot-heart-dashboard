import { z } from "zod";
import { jsonrepair } from "jsonrepair";
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
  /** Internal request cancellation signal; never accepted from a JSON body. */
  signal?: AbortSignal | undefined;
}

const taskPlanRequestSchema = z.object({
  taskId: z.string().min(1).max(128).optional(),
  userRequest: z.string().min(1).max(4000),
  targetId: z.string().min(1).max(128).optional(),
  providerId: z.enum(["qwen", "gemini", "grok"]).optional(),
  profileId: z.string().min(1).max(128).optional(),
  context: z.array(z.string().min(1).max(500)).max(12).optional().default([]),
  modelOverride: z.string().min(1).max(128).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional().default(300000),
});

function linkedTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    controller,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

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
  if (!rateBuckets.has(key) && rateBuckets.size >= 256) {
    const oldestKey = rateBuckets.keys().next().value as string | undefined;
    if (oldestKey) rateBuckets.delete(oldestKey);
  }
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

export function parseGeminiPlanText(text: string): ProviderResult {
  const candidate = extractJsonObject(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (firstError) {
    try {
      parsed = JSON.parse(jsonrepair(candidate));
    } catch {
      throw new Error(
        firstError instanceof Error ? `Gemini returned malformed plan JSON: ${firstError.message}` : "Gemini returned malformed plan JSON.",
      );
    }
  }
  return normalizeProviderResponse(parsed);
}

/** xAI accepts the shared schema except for the empty allOf array we keep for Gemini compatibility. */
export function toXaiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toXaiResponseSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "allOf" && Array.isArray(value) && value.length === 0) continue;
      out[key] = toXaiResponseSchema(value);
    }
    return out;
  }
  return schema;
}

/**
 * Strip additionalProperties from JSON schemas if needed.
 */
export function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiResponseSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === "additionalProperties" || key === "maxItems" || key === "allOf") continue;
      out[key] = toGeminiResponseSchema(value);
    }
    return out;
  }
  return schema;
}

function getLocalModelConfig() {
  const baseUrl = process.env["LOCAL_LLM_BASE_URL"]?.trim() || "http://127.0.0.1:8081";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error("LOCAL_LLM_BASE_URL must be a valid loopback URL."), { code: "invalid_configuration", status: 503 });
  }
  if (!(["127.0.0.1", "localhost"].includes(parsed.hostname) && parsed.protocol === "http:" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash)) {
    throw Object.assign(new Error("LOCAL_LLM_BASE_URL must use http://localhost or http://127.0.0.1 without credentials or query parameters."), { code: "invalid_configuration", status: 503 });
  }
  const model = process.env["LOCAL_LLM_MODEL"]?.trim() || "qwen";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw Object.assign(new Error("LOCAL_LLM_MODEL is invalid."), { code: "invalid_configuration", status: 503 });
  }
  const normalized = baseUrl.replace(/\/+$/, "");
  return {
    model,
    endpoint: normalized.endsWith("/v1") ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`,
  };
}

async function generateGeminiTaskPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  const key = process.env["GEMINI_API_KEY"]?.trim();
  if (!key) {
    throw Object.assign(new Error("Gemini is selected but GEMINI_API_KEY is not configured on the server."), {
      code: "missing_credentials",
      status: 503,
    });
  }

  const configuredModel = process.env["GEMINI_MODEL"]?.trim() || "gemini-3.8-flash";
  const requestedModel = input.modelOverride?.trim();
  const model =
    requestedModel && requestedModel !== "gemini-2.5-flash" ? requestedModel : configuredModel;
  if (!/^gemini-[a-zA-Z0-9.-]+$/.test(model)) {
    throw Object.assign(new Error("The selected Gemini model name is invalid."), {
      code: "invalid_request",
      status: 400,
    });
  }
  const request = linkedTimeout(input.signal, input.timeoutMs ?? 300000);
  const controller = request.controller;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: LOCAL_SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: buildPrompt(input) }] }],
          generationConfig: {
            maxOutputTokens: 1200,
            responseMimeType: "application/json",
            responseSchema: toGeminiResponseSchema(PLAN_JSON_SCHEMA),
            thinkingConfig: { thinkingLevel: "low" },
          },
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const status = response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 502 : 502;
      throw Object.assign(new Error(`Gemini planning failed (HTTP ${response.status}). ${detail.slice(0, 300)}`), {
        code: response.status === 429 ? "rate_limit" : "gemini_error",
        status,
      });
    }
    const data = (await response.json()) as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw Object.assign(new Error("Gemini plan reached the output limit; no partial plan was accepted."), {
        code: "invalid_response",
        status: 502,
      });
    }
    const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    if (!text.trim()) {
      throw Object.assign(new Error("Gemini returned an empty plan."), { code: "invalid_response", status: 502 });
    }
    try {
      return parseGeminiPlanText(text);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : "Gemini returned an invalid plan."), {
        code: "invalid_response",
        status: 502,
      });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw input.signal?.aborted
        ? Object.assign(new Error("Gemini planning request was cancelled."), { code: "cancelled", status: 499 })
        : Object.assign(new Error("Gemini planning request timed out."), { code: "timeout", status: 504 });
    }
    if (error && typeof error === "object" && "code" in error) throw error;
    throw Object.assign(new Error("Could not reach the Gemini planning service."), { code: "network_error", status: 502 });
  } finally {
    request.cleanup();
  }
}

async function generateGrokTaskPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  const key = process.env["XAI_API_KEY"]?.trim();
  if (!key) {
    throw Object.assign(new Error("Grok is selected but XAI_API_KEY is not configured on the server."), {
      code: "missing_credentials",
      status: 503,
    });
  }

  const model = (input.modelOverride?.trim() || process.env["XAI_MODEL"]?.trim() || "grok-4.7");
  if (!/^grok-[a-zA-Z0-9.-]+$/.test(model)) {
    throw Object.assign(new Error("The selected Grok model name is invalid."), {
      code: "invalid_request",
      status: 400,
    });
  }

  const request = linkedTimeout(input.signal, input.timeoutMs ?? 300000);
  const controller = request.controller;
  try {
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_output_tokens: 1200,
        input: [
          { role: "system", content: LOCAL_SYSTEM },
          { role: "user", content: buildPrompt(input) },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "desktop_task_plan",
            schema: toXaiResponseSchema(PLAN_JSON_SCHEMA),
            strict: true,
          },
        },
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const status = response.status === 429 ? 429 : response.status === 401 || response.status === 403 ? 502 : 502;
      throw Object.assign(new Error(`Grok planning failed (HTTP ${response.status}). ${detail.slice(0, 300)}`), {
        code: response.status === 429 ? "rate_limit" : response.status === 401 || response.status === 403 ? "auth_failed" : "grok_error",
        status,
      });
    }
    const data = (await response.json()) as {
      status?: string;
      incomplete_details?: { reason?: string } | null;
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string; refusal?: string }>;
      }>;
    };
    if (data.status === "incomplete" || data.incomplete_details) {
      throw Object.assign(new Error("Grok plan reached the output limit; no partial plan was accepted."), {
        code: "invalid_response",
        status: 502,
      });
    }
    const output = data.output ?? [];
    const refusal = output.flatMap((item) => item.content ?? []).find((item) => item.type === "refusal");
    if (refusal) {
      throw Object.assign(new Error("Grok declined to produce a desktop plan."), {
        code: "invalid_response",
        status: 502,
      });
    }
    const text = output
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text ?? "")
      .join("");
    if (!text?.trim()) {
      throw Object.assign(new Error("Grok returned an empty plan."), { code: "invalid_response", status: 502 });
    }
    try {
      return normalizeProviderResponse(text);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : "Grok returned an invalid plan."), {
        code: "invalid_response",
        status: 502,
      });
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw input.signal?.aborted
        ? Object.assign(new Error("Grok planning request was cancelled."), { code: "cancelled", status: 499 })
        : Object.assign(new Error("Grok planning request timed out."), { code: "timeout", status: 504 });
    }
    if (error && typeof error === "object" && "code" in error) throw error;
    throw Object.assign(new Error("Could not reach the Grok planning service."), { code: "network_error", status: 502 });
  } finally {
    request.cleanup();
  }
}

/** Selects the server-side Gemini route or the local llama-server route. */

export async function generateTaskPlan(input: TaskPlanRequestInput): Promise<ProviderResult> {
  if (input.providerId && !["qwen", "gemini", "grok"].includes(input.providerId)) {
    throw Object.assign(new Error(`Unsupported AI provider: ${input.providerId}`), {
      code: "invalid_request",
      status: 400,
    });
  }
  if (input.providerId === "grok") return generateGrokTaskPlan(input);
  if (input.providerId === "gemini") return generateGeminiTaskPlan(input);
  const { endpoint, model: configuredModel } = getLocalModelConfig();
  const model = input.modelOverride?.trim() || configuredModel;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw Object.assign(new Error("The selected local model name is invalid."), { code: "invalid_request", status: 400 });
  }
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
    const request = linkedTimeout(input.signal, timeoutMs);
    const controller = request.controller;
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
      if (controller.signal.aborted) {
        if (input.signal?.aborted) {
          throw Object.assign(new Error("Local Qwen planning request was cancelled."), {
            code: "cancelled",
            status: 499,
          });
        }
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
      if (error && typeof error === "object" && "code" in error) {
        throw error;
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
      request.cleanup();
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

  if (isRateLimited("task-plan-api")) {
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
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
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
    const result = await generateTaskPlan({ ...parsed.data, signal: request.signal });
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
