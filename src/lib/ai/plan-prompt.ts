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
  "You are DesktopPilot's local task planner. Return JSON only, matching the exact schema. Max 3 actions per planning response. Return only the next small batch of actions needed, not the entire task plan. Each batch must remain consistent with the current objective and the latest available desktop observation. Keep descriptions concise. " +
  "REAL DESKTOP MODE RULES: Never generate focus_window in Real Desktop mode. " +
  "Use only action kinds explicitly supported by the real desktop worker's action schema. Never invent or use unsupported worker actions. " +
  "Use read_screen to inspect the current desktop before deciding how to interact. " +
  "A click action MUST include x and y as non-negative integers. Use click only when both coordinates are explicitly available from a fresh screen observation in the supplied context. Never guess, infer, reuse stale, or fabricate coordinates. " +
  "If valid fresh coordinates are unavailable, do not emit click. Use read_screen again, or use supported keyboard actions such as key_press with Tab, Shift+Tab, Enter, Escape, or an appropriate shortcut. Use type_text, paste, copy_selection, and wait only when supported and appropriate. " +
  "Every key_press action MUST include a non-empty keys string. Use only keyboard keys or shortcuts supported by the existing worker allowlist. Never generate key_press without keys. Do not invent unsupported shortcuts. " +
  "Never use focus_window, even as a fallback, in Real Desktop mode. Do not substitute unsupported action names for prohibited actions. " +
  "For verification, use only verification methods supported by the actual worker schema, such as worker_ok or screen_capture when available. Use text_match only when expectedText is provided. Use clipboard verification only after copy_selection has been performed and clipboard data is available. Never invent verification types or fields. " +
  "Every step must include action, requiresApproval, and verification, using the exact required schema fields and types. " +
  "Keep the plan, summary, and descriptions brief. Return valid JSON only: no Markdown, code fences, comments, or explanatory text.";

/** Strict JSON schema the model must emit. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "summary", "steps"],
  properties: {
    plan: { type: "array", maxItems: 3, items: { type: "string" } },
    summary: { type: "string" },
    steps: {
      type: "array",
      maxItems: 3,
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
            anyOf: [
              {
                properties: {
                  kind: {
                    enum: [
                      "read_screen",
                      "click",
                      "type_text",
                      "wait",
                      "copy_selection",
                      "paste",
                    ],
                  },
                },
              },
              {
                properties: {
                  kind: { enum: ["key_press"] },
                },
                required: ["keys"],
              },
            ],
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
