import { z } from "zod";
import type { AccountProfile, ActionRequest, Provider } from "@/lib/types";

export type ProviderErrorCode = "missing_credentials" | "auth_failed" | "rate_limit" | "timeout" | "invalid_response" | "network_error" | "unknown";

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
  readonly type: "mock" | "openai" | "custom";
  getNextStep(request: AIRequest): Promise<AIProviderResult>;
}

const actionSchema = z.object({
  kind: z.enum(["focus_window", "read_screen", "click", "type_text", "key_press", "wait", "copy_selection", "paste"]),
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

export function resolveProviderCredential(name?: string, profile?: AccountProfile): string | undefined {
  const envNames = [name, profile?.credentialRef, "OPENAI_API_KEY", "VITE_OPENAI_API_KEY"]
    .filter((value): value is string => Boolean(value && value.trim()));
  for (const candidate of envNames) {
    const fromNode = typeof process !== "undefined" ? process.env[candidate] : undefined;
    const fromMeta = typeof import.meta !== "undefined" ? import.meta.env?.[candidate] ?? import.meta.env?.[`VITE_${candidate}`] : undefined;
    const value = fromNode ?? fromMeta;
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function normalizeProviderResponse(data: unknown): ProviderResult {
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  const payload = responseSchema.safeParse(parsed);
  if (!payload.success) {
    throw new Error(`Malformed provider response: ${payload.error.issues.map((issue) => issue.message).join("; ")}`);
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

function extractResponseMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "Invalid provider response";
  const record = data as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof record.message === "string") return record.message;
  return "Unexpected provider response";
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  let data: unknown = undefined;
  try {
    data = await response.json();
  } catch {
    data = await response.text();
  }
  if (!response.ok) {
    const message = extractResponseMessage(data);
    const status = response.status;
    if (status === 401) throw Object.assign(new Error(message || "Authentication with the provider failed"), { code: "auth_failed" });
    if (status === 429) throw Object.assign(new Error(message || "Rate limited by the provider"), { code: "rate_limit" });
    if (status >= 500) throw Object.assign(new Error(message || "Provider server error"), { code: "network_error" });
    throw Object.assign(new Error(message || "Provider request failed"), { code: "unknown" });
  }
  return data;
}

export class OpenAIProvider implements ProviderAdapter {
  readonly name = "OpenAI";
  readonly type = "openai" as const;

  constructor(private readonly apiKey?: string, private readonly timeoutMs = 20000) {}

  async getNextStep(request: AIRequest): Promise<AIProviderResult> {
    const key = request.profile?.credentialRef ? resolveProviderCredential(request.profile.credentialRef) ?? this.apiKey : this.apiKey ?? resolveProviderCredential("OPENAI_API_KEY", request.profile);
    if (!key) {
      return { ok: false, code: "missing_credentials", message: "OpenAI API key is not configured. Set OPENAI_API_KEY or the matching credential reference.", retryable: false };
    }
    const model = request.modelOverride || request.provider.model || "gpt-4o-mini";
    const body = {
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return JSON only with plan, summary, and an optional nextAction matching the desktop action schema. Never invent unapproved shell or file operations.",
        },
        {
          role: "user",
          content: `Task: ${request.userRequest}\nTarget: ${request.targetId ?? "desktop"}\nContext: ${request.context?.join(" | ") ?? "none"}`,
        },
      ],
    };

    try {
      const data = await requestJson("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify(body),
      });

      const choices = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices ?? [];
      const text = choices[0]?.message?.content;
      if (!text) {
        throw Object.assign(new Error("OpenAI returned an empty response"), { code: "invalid_response" });
      }
      const payload = JSON.parse(text);
      return normalizeProviderResponse(payload);
    } catch (error) {
      const err = error as Error & { code?: ProviderErrorCode };
      if (err?.code === "auth_failed") return { ok: false, code: "auth_failed", message: err.message, retryable: false };
      if (err?.code === "rate_limit") return { ok: false, code: "rate_limit", message: err.message, retryable: true };
      if (err?.code === "network_error") return { ok: false, code: "network_error", message: err.message, retryable: true };
      if (err?.name === "TimeoutError" || (err?.message || "").toLowerCase().includes("timeout")) return { ok: false, code: "timeout", message: "OpenAI request timed out.", retryable: true };
      if (err) {
        const message = err.message || "Invalid response from OpenAI";
        return { ok: false, code: "invalid_response", message, retryable: false };
      }
      return { ok: false, code: "unknown", message: "Unknown provider error", retryable: true };
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

export function createAIProvider(provider: Provider, profile?: AccountProfile, overrides?: { apiKey?: string; timeoutMs?: number }): ProviderAdapter {
  if (provider.type === "openai") return new OpenAIProvider(overrides?.apiKey ?? resolveProviderCredential(profile?.credentialRef, profile) ?? resolveProviderCredential("OPENAI_API_KEY"), overrides?.timeoutMs ?? 20000);
  return new MockAIProvider();
}
