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
  taskId?: string;
  userRequest: string;
  targetId?: string;
  provider: Provider;
  profile?: AccountProfile;
  context?: string[];
  modelOverride?: string;
  timeoutMs?: number;
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
      "focus_window",
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
    text: z.string().max(5000).optional(),
    x: z.number().int().min(0).max(60000).optional(),
    y: z.number().int().min(0).max(60000).optional(),
    keys: z.string().max(50).optional(),
    durationMs: z.number().int().min(0).max(60000).optional(),
    observationId: z.string().optional(),
    requiresApproval: z.boolean().optional(),
  })
  .transform(({ requiresApproval: _requiresApproval, ...action }): ActionRequest => ({
    kind: action.kind,
    targetId: action.targetId,
    description: action.description,
    ...(action.text !== undefined ? { text: action.text } : {}),
    ...(action.x !== undefined ? { x: action.x } : {}),
    ...(action.y !== undefined ? { y: action.y } : {}),
    ...(action.keys !== undefined ? { keys: action.keys } : {}),
    ...(action.durationMs !== undefined ? { durationMs: action.durationMs } : {}),
    ...(action.observationId !== undefined ? { observationId: action.observationId } : {}),
  }));

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
      }),
    )
    .max(12)
    .optional()
    .default([]),
});

export function normalizeProviderResponse(data: unknown): ProviderResult {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  const payload = responseSchema.safeParse(parsed);
  if (!payload.success) {
    throw new Error(
      `Malformed provider response: ${payload.error.issues.map((issue) => issue.message).join("; ")}`,
    );
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

/** Backwards-compatible export for any existing tests/imports. */
export const GeminiProvider = LocalQwenProvider;

export class MockAIProvider implements ProviderAdapter {
  readonly name = "Mock AI";
  readonly type = "mock" as const;

  async getNextStep(request: AIRequest): Promise<AIProviderResult> {
    const plan = [
      `Understand the task: ${request.userRequest}`,
      "Break it into a safe desktop action.",
      "Verify the outcome before marking the task complete.",
    ];
    const nextAction: ActionRequest = {
      kind: "read_screen",
      targetId: request.targetId ?? "desktop",
      description: "Inspect the current desktop state before acting.",
    };
    return {
      ok: true,
      plan,
      summary: "Mock plan ready for tests.",
      nextAction,
      requiresApproval: false,
      steps: [
        { action: nextAction, requiresApproval: false, verification: { kind: "screen_capture" } },
      ],
    };
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
  return new LocalQwenProvider();
}
