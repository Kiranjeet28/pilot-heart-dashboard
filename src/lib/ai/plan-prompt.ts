// Shared, secret-free planning prompt + schema for DesktopPilot's local Qwen planner.
// Kept compact, stable and bounded for local llama-server context and prompt cache reuse.

export interface PlanPromptInput {
  userRequest: string;
  targetId?: string | undefined;
  context?: string[] | undefined;
}

/** Stable system prompt for llama.cpp prompt-cache reuse across planning calls. */
export const LOCAL_SYSTEM =
  "You are DesktopPilot's local task planner. Return valid JSON only matching the schema (max 12 steps). Plan safe desktop automation for the target.";

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
 * Compact, consistent prompt for initial planning and replanning.
 * Pins target ID, user objective, allowed action kinds, verification rules, and max steps.
 * Omits redundant schema duplicates since llama-server grammar enforces response_format directly.
 */
export function buildPlanPrompt(input: PlanPromptInput): string {
  const targetId = input.targetId ?? "desktop";
  const safeRequest = input.userRequest.trim();
  const contextLines = input.context?.filter((c) => c && c.trim().length > 0) ?? [];
  const contextBlock = contextLines.length
    ? `\nContext:\n${contextLines.map((item) => `- ${item.trim()}`).join("\n")}`
    : "";

  return [
    `Selected target: "${targetId}". Every action's targetId MUST be exactly "${targetId}".`,
    `Task: ${safeRequest}${contextBlock}`,
    "Allowed actions: focus_window, read_screen, click, type_text, key_press, wait, copy_selection, paste.",
    "Verification: worker_ok and screen_capture are always allowed. Use text_match only with expectedText for known on-screen text. Use clipboard only for copy_selection.",
    "Requirements: Safe actions only. Max 12 steps. Every step must have action, requiresApproval, and verification.",
  ].join("\n");
}
