// Shared, secret-free planning prompt + schema for DesktopPilot's local Qwen planner.
// Kept compact, stable and bounded for local llama-server context and prompt cache reuse.

export interface PlanPromptInput {
  userRequest: string;
  targetId?: string | undefined;
  context?: string[] | undefined;
}

/**
 * Static planning rules live here (not in the per-request user prompt) so llama.cpp
 * `cache_prompt` can reuse a stable prefix. Keep this short: prompt eval on CPU is costly.
 */
export const LOCAL_SYSTEM =
  "You are DesktopPilot's local task planner. Return JSON only, matching the exact schema. Max 12 steps total across batches; emit at most 3 actions per planning response batch. Return only the next small batch, not the entire remaining plan. Keep plan, summary, and descriptions brief. " +
  "REAL DESKTOP MODE RULES: Never generate focus_window in Real Desktop mode. Never use focus_window, even as a fallback. " +
  "Allowed action kinds: launch_app, read_screen, click, type_text, key_press, wait, copy_selection, paste. launch_app supports only app=notepad. Never invent unsupported worker actions. " +
  "A click action MUST include x and y as non-negative integers grounded in a fresh screenshot supplied in the current prompt. Never guess coordinates. If no screenshot is supplied, do not click; use a suitable approved action or return no steps with a clear summary. " +
  "Every key_press action MUST include a non-empty keys string from the worker allowlist. " +
  "Verification kinds: worker_ok, screen_capture, text_match (only with expectedText), clipboard (only after copy_selection). " +
  "Required JSON fields: top-level plan, summary, steps; each step action, requiresApproval; each action kind, targetId, description. Optional verification {kind}. " +
  "If the objective is complete after this batch, include '[complete]' in the summary. No Markdown, code fences, or extra text.";

/** Strict JSON schema the model must emit. Avoid anyOf — llama.cpp GBNF mishandles it. */
export const PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["plan", "summary", "steps"],
  properties: {
    plan: { type: "array", maxItems: 12, items: { type: "string" } },
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
                  "launch_app",
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
              app: { type: "string", enum: ["notepad"] },
              text: { type: "string" },
              x: { type: "integer", minimum: 0 },
              y: { type: "integer", minimum: 0 },
              keys: { type: "string" },
              durationMs: { type: "integer" },
              observationId: { type: "string" },
            },
            allOf: [
              {
                if: { properties: { kind: { const: "click" } }, required: ["kind"] },
                then: { required: ["x", "y", "observationId"] },
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
