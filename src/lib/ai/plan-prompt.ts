// Shared, secret-free planning prompt + schema for DesktopPilot's local Qwen planner.
// Kept compact, stable and bounded for local llama-server context and prompt cache reuse.

export interface PlanPromptInput {
  userRequest: string;
  targetId?: string | undefined;
  context?: string[] | undefined;
}

/**
 * Static planning rules live here (not in the per-request user prompt) so llama.cpp
 * `cache_prompt` can reuse a stable prefix. Semantic constraints that the JSON schema
 * grammar cannot enforce â€” safety, target pinning, verification usage â€” stay explicit.
 */
export const LOCAL_SYSTEM =
  "You are DesktopPilot's local task planner. JSON only, matching the schema. Max 12 safe steps. " +
  "Actions: read_screen, click, type_text, key_press, wait, copy_selection, paste. " +
  "Never use focus_window; the real worker does not support it. " +
  "Verify with worker_ok or screen_capture; text_match only with expectedText; clipboard only after copy_selection. " +
  "Each step needs action, requiresApproval, and verification. Keep plan, summary, and descriptions brief.";

/** Strict JSON schema the model must emit. */
export const PLAN_JSON_SCHEMA = {
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
              x: { type: "integer", minimum: 0 },
              y: { type: "integer", minimum: 0 },
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

/** Drop blanks and exact duplicate context lines; keep the newest copy of each line. */
export function uniqueContext(context?: string[]): string[] {
  const last = new Map<string, string>();
  for (const raw of context ?? []) {
    const line = raw.trim();
    if (!line) continue;
    const key = line.toLowerCase();
    last.delete(key);
    last.set(key, line);
  }
  return [...last.values()];
}

/**
 * Per-request user prompt: only the varying target, task, and relevant context.
 * Static action/verification/step rules live in LOCAL_SYSTEM.
 */
export function buildPlanPrompt(input: PlanPromptInput): string {
  const targetId = input.targetId ?? "desktop";
  const safeRequest = input.userRequest.trim();
  const contextLines = uniqueContext(input.context);
  const contextBlock = contextLines.length
    ? `\nContext:\n${contextLines.map((item) => `- ${item}`).join("\n")}`
    : "";

  return [
    `Selected target: "${targetId}". Every action's targetId MUST be exactly "${targetId}".`,
    `Task: ${safeRequest}${contextBlock}`,
  ].join("\n");
}
