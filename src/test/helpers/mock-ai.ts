import type { AIRequest, AIProviderResult, ProviderAdapter } from "@/lib/ai/provider";

/** Test-only provider fake. It cannot be selected by the application. */
export class MockAIProvider implements ProviderAdapter {
  readonly name = "Test fake";
  readonly type = "mock" as const;
  async getNextStep(request: AIRequest): Promise<AIProviderResult> {
    const action = { kind: "read_screen" as const, targetId: request.targetId ?? "desktop", description: "Inspect the current desktop state." };
    return { ok: true, plan: [action.description], summary: "Test plan", nextAction: action, requiresApproval: false, steps: [{ action, requiresApproval: false, verification: { kind: "screen_capture" } }] };
  }
}
