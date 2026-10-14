// Shared, secret-free planning prompt + schema. Used by the server Gemini route and the
// browser-side local-model fallback so both ask for exactly the same plan format.
export interface PlanPromptInput {
  userRequest: string;
  targetId?: string | undefined;
  context?: string[] | undefined;
}

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

export function buildPlanPrompt(input: PlanPromptInput): string {
  const safeRequest = input.userRequest.trim();
  const targetLine = `Selected desktop target ID: ${input.targetId ?? "desktop"}. Every action's targetId MUST be exactly this value.`;
  const contextText = input.context?.length
    ? `\nContext:\n${input.context.map((item) => `- ${item}`).join("\n")}`
    : "";
  return [
    "Return only valid JSON with this exact shape:",
    "{",
    '  "plan": ["step 1 description", "step 2 description"],',
    '  "summary": "short summary",',
    '  "steps": [{ "action": { "kind": "read_screen", "targetId": "<selected target id>", "description": "inspect the desktop" }, "requiresApproval": false, "verification": { "kind": "screen_capture" } }]',
    "}",
    "Choose only safe desktop actions from this allowlist: focus_window, read_screen, click, type_text, key_press, wait, copy_selection, paste.",
    targetLine,
    `Task: ${safeRequest}${contextText}`,
    "Verification kinds: worker_ok and screen_capture are always allowed. Use text_match only when you also provide expectedText for text you know will appear on screen. Use clipboard only for copy_selection steps. Never invent verification evidence.",
    "Keep the plan bounded to at most 12 steps and realistic for DesktopPilot. Include verification for every step and avoid unsafe or destructive actions.",
    "The response must be parseable by JSON.parse without commentary or markdown fences.",
  ].join("\n");
}

