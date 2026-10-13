import { z } from "zod";
import type { AccountProfile, ActionRequest, Provider } from "@/lib/types";

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

const actionSchema = z.object({
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
});

const responseSchema = z.object({
  plan: z.array(z.string()).default([]),
  summary: z.string().min(1).max(2000).optional(),
  nextAction: actionSchema.optional().nullable(),
  requiresApproval: z.boolean().optional(),
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
  return {
    ok: true,
    plan: output.plan.length ? output.plan : [output.summary ?? "Continue the task."],
    summary: output.summary ?? output.nextAction?.description ?? "Continue the task.",
    nextAction: output.nextAction ?? null,
    requiresApproval: Boolean(output.requiresApproval),
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
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof record.message === "string") return record.message;
  return "Unexpected provider response";
}

export class GeminiProvider implements ProviderAdapter {
  readonly name = "Gemini";
  readonly type = "gemini" as const;

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
          timeoutMs: request.timeoutMs ?? 30000,
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
          error instanceof Error ? error.message : "Malformed Gemini response",
          false,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini request failed";
      const lower = message.toLowerCase();
      if (lower.includes("timeout")) return makeProviderFailure("timeout", message, true);
      return makeProviderFailure("network_error", message, true);
    }
  }
}

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
    };
  }
}

export function createAIProvider(
  provider: Provider,
  profile?: AccountProfile,
  overrides?: { apiKey?: string; timeoutMs?: number },
): ProviderAdapter {
  if (provider.type === "gemini") return new GeminiProvider();
  if (provider.type === "openai") return new MockAIProvider();
  return new MockAIProvider();
}
