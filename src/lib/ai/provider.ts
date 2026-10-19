import { z } from "zod";
import type { AccountProfile, ActionRequest, Provider, VerificationSpec } from "@/lib/types";

export type ProviderErrorCode =
  | "missing_credentials"
  | "auth_failed"
  | "rate_limit"
  | "timeout"
  | "invalid_response"
  | "network_error"
  | "unknown";

export interface AIRequest {
  taskId?: string | undefined;
  userRequest: string;
  targetId?: string | undefined;
  provider: Provider;
  profile?: AccountProfile | undefined;
  context?: string[] | undefined;
  modelOverride?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface ProviderResult {
  ok: true;
  plan: string[];
  summary: string;
  nextAction?: ActionRequest | null;
  requiresApproval?: boolean;
  steps: Array<{
    action: ActionRequest;
    requiresApproval: boolean;
    verification?: VerificationSpec;
  }>;
  raw?: unknown;
}

export interface ProviderFailure {
  ok: false;
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
}

export type AIProviderResult = ProviderResult | ProviderFailure;

export interface ProviderAdapter {
  readonly name: string;
  readonly type: "mock" | "gemini" | "custom";
  getNextStep(request: AIRequest): Promise<AIProviderResult>;
}

const actionSchema = z
  .object({
    kind: z.enum([
      "launch_app",
      "read_screen",
      "click",
      "type_text",
      "key_press",
      "wait",
      "copy_selection",
      "paste",
    ]),
    targetId: z.string().min(1),
    description: z.string().min(1).max(600),
    app: z.enum(["notepad"]).optional(),
    text: z.string().max(5000).optional(),
    x: z.number().int().min(0).max(60000).optional(),
    y: z.number().int().min(0).max(60000).optional(),
    keys: z.string().max(50).optional(),
    durationMs: z.number().int().min(0).max(60000).optional(),
    observationId: z.string().optional(),
    requiresApproval: z.boolean().optional(),
  }).strict()
  .superRefine((action, ctx) => {
    if (action.kind === "click" && (action.x == null || action.y == null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "click requires x and y as non-negative integers; do not guess coordinates",
      });
    }
    if (action.kind === "key_press" && (!action.keys || !action.keys.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "key_press requires keys",
      });
    }
  })
  .transform(({ requiresApproval: _requiresApproval, ...action }): ActionRequest => ({
    kind: action.kind,
    targetId: action.targetId,
    description: action.description,
    ...(action.kind === "launch_app"
      ? { app: action.app ?? "notepad" }
      : action.app !== undefined
        ? { app: action.app }
        : {}),
    ...(action.text !== undefined ? { text: action.text } : {}),
    ...(action.x !== undefined ? { x: action.x } : {}),
    ...(action.y !== undefined ? { y: action.y } : {}),
    ...(action.keys !== undefined ? { keys: action.keys } : {}),
    ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
    ...(action.observationId !== undefined ? { observationId: action.observationId } : {}),
  }));

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
      const received =
        "received" in issue &&
        issue.received !== undefined &&
        !issue.message.toLowerCase().includes("received")
          ? ` (received ${String(issue.received)})`
          : "";
      return `${path}: ${issue.message}${received}`;
    })
    .join("; ");
}

const responseSchema = z.object({
  plan: z.array(z.string()).default([]),
  summary: z.string().min(1).max(2000).optional(),
  nextAction: actionSchema.optional().nullable(),
  requiresApproval: z.boolean().optional(),
  steps: z
    .array(
      z.object({
        action: actionSchema,
        requiresApproval: z.boolean().optional(),
        verification: z
          .object({
            kind: z.enum(["worker_ok", "screen_capture", "text_match", "clipboard"]),
            expectedText: z.string().max(2000).optional(),
            allowPartial: z.boolean().optional(),
          })
        .optional(),
      }).strict(),
    )
    .max(12)
    .optional()
    .default([]),
}).strict();

export function normalizeProviderResponse(data: unknown): ProviderResult {
  let parsed = data;
  if (typeof data === "string") {
    let text = data.trim();
    if (text.startsWith("```")) {
      text = text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    }
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  }

  // Safe normalization: if steps contains direct action objects without the 'action' wrapper
  if (
    parsed &&
    typeof parsed === "object" &&
    "steps" in parsed &&
    Array.isArray((parsed as { steps: unknown }).steps)
  ) {
    const rawSteps = (parsed as { steps: unknown[] }).steps;
    const normalizedSteps = rawSteps.map((step) => {
      if (step && typeof step === "object") {
        const stepObj = step as Record<string, unknown>;
        if ("action" in stepObj && stepObj["action"] && typeof stepObj["action"] === "object") {
          return step;
        }
        if ("kind" in stepObj) {
          const requiresApproval = stepObj["requiresApproval"];
          const verification = stepObj["verification"];
          const actionProps = { ...stepObj };
          delete actionProps["requiresApproval"];
          delete actionProps["verification"];
          return {
            action: actionProps,
            ...(requiresApproval !== undefined ? { requiresApproval } : {}),
            ...(verification !== undefined ? { verification } : {}),
          };
        }
      }
      return step;
    });
    parsed = { ...parsed, steps: normalizedSteps };
  }

  const payload = responseSchema.safeParse(parsed);
  if (!payload.success) {
    throw new Error(`Malformed provider response: ${formatZodError(payload.error)}`);
  }
  const output = payload.data;
  const steps = output.steps.length
    ? output.steps.map((step) => ({
        action: step.action,
        requiresApproval: Boolean(step.requiresApproval ?? output.requiresApproval),
        ...(step.verification
          ? {
              verification: {
                kind: step.verification.kind,
                ...(step.verification.expectedText !== undefined
                  ? { expectedText: step.verification.expectedText }
                  : {}),
                ...(step.verification.allowPartial !== undefined
                  ? { allowPartial: step.verification.allowPartial }
                  : {}),
              },
            }
          : {}),
      }))
    : output.nextAction
      ? [
          {
            action: output.nextAction,
            requiresApproval: Boolean(output.requiresApproval),
          },
        ]
      : [];
  return {
    ok: true,
    plan: output.plan.length ? output.plan : [output.summary ?? "Continue the task."],
    summary: output.summary ?? output.nextAction?.description ?? "Continue the task.",
    nextAction: output.nextAction ?? null,
    requiresApproval: Boolean(output.requiresApproval),
    steps,
    raw: parsed,
  };
}

function makeProviderFailure(
  code: ProviderErrorCode,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return { ok: false, code, message, retryable };
}

function extractResponseMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "Unexpected provider response";
  const record = data as Record<string, unknown>;
  if (typeof record["error"] === "string") return record["error"];
  if (record["error"] && typeof record["error"] === "object") {
    const message = (record["error"] as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  if (typeof record["message"] === "string") return record["message"];
  return "Unexpected provider response";
}

export class LocalQwenProvider implements ProviderAdapter {
  readonly name = "Local Qwen";
  readonly type = "custom" as const;

  async getNextStep(request: AIRequest): Promise<AIProviderResult> {
    try {
      const response = await fetch("/api/tasks/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(request.signal ? { signal: request.signal } : {}),
        body: JSON.stringify({
          taskId: request.taskId,
          userRequest: request.userRequest,
          targetId: request.targetId ?? "desktop",
          providerId: request.provider.id,
          profileId: request.profile?.id ?? "",
          context: request.context ?? [],
          modelOverride: request.modelOverride ?? request.provider.model,
          timeoutMs: request.timeoutMs ?? 60000,
        }),
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }

      if (!response.ok) {
        const reason = extractResponseMessage(payload);
        if (response.status === 401) return makeProviderFailure("auth_failed", reason, false);
        if (response.status === 429) return makeProviderFailure("rate_limit", reason, true);
        if (response.status >= 500) return makeProviderFailure("network_error", reason, true);
        return makeProviderFailure("unknown", reason, false);
      }

      try {
        return normalizeProviderResponse(payload);
      } catch (error) {
        return makeProviderFailure(
          "invalid_response",
          error instanceof Error ? error.message : "Malformed plan response",
          false,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Planning request failed";
      const lower = message.toLowerCase();
      if (lower.includes("timeout")) return makeProviderFailure("timeout", message, true);
      return makeProviderFailure("network_error", message, true);
    }
  }
}

/** Gemini planning is routed through the authenticated server route; API keys never reach the browser. */
export class GeminiProvider implements ProviderAdapter {
  readonly name = "Google Gemini";
  readonly type = "gemini" as const;
  private readonly serverAdapter = new LocalQwenProvider();

  getNextStep(request: AIRequest): Promise<AIProviderResult> {
    return this.serverAdapter.getNextStep(request);
  }
}

/** Grok plans through the same authenticated server route; XAI_API_KEY stays server-side. */
export class GrokProvider implements ProviderAdapter {
  readonly name = "Grok (xAI)";
  readonly type = "custom" as const;
  private readonly serverAdapter = new LocalQwenProvider();

  getNextStep(request: AIRequest): Promise<AIProviderResult> {
    return this.serverAdapter.getNextStep(request);
  }
}

class UnsupportedProvider implements ProviderAdapter {
  readonly type = "custom" as const;
  constructor(readonly name: string) {}

  async getNextStep(): Promise<ProviderFailure> {
    return {
      ok: false,
      code: "unknown",
      message: `${this.name} is not implemented. DesktopPilot uses local Qwen exclusively.`,
      retryable: false,
    };
  }
}

export function createAIProvider(
  provider: Provider,
  profile?: AccountProfile,
  overrides?: { apiKey?: string; timeoutMs?: number },
): ProviderAdapter {
  if (provider.id === "grok" || provider.type === "grok") return new GrokProvider();
  if (provider.id === "gemini" || provider.type === "gemini") return new GeminiProvider();
  return new LocalQwenProvider();
}
