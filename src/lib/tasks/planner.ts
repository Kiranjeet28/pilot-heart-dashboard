import type { ProviderResult } from "@/lib/ai/provider";
import { validateAction } from "@/lib/worker/action-validation";
import type { ActionKind, DesktopTarget, PlannedStep } from "@/lib/types";

let n = 0;
const sid = () => `step_${Date.now().toString(36)}_${(n++).toString(36)}`;

export function planDemoSteps(description: string, target: DesktopTarget): PlannedStep[] {
  const t = target.id;
  const snippet = description.trim().slice(0, 120);
  const needsApproval = target.interactionMode !== "autonomous";
  return [
    {
      id: sid(),
      requiresApproval: false,
      action: {
        kind: "focus_window",
        targetId: t,
        description: `Focus window matching "${target.windowTitleContains || target.displayName}"`,
      },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "read_screen", targetId: t, description: "Read current screen state" },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "click", targetId: t, x: 320, y: 240, description: "Click into input area" },
    },
    {
      id: sid(),
      requiresApproval: needsApproval,
      action: {
        kind: "type_text",
        targetId: t,
        text: snippet,
        description: `Type task prompt: "${snippet.slice(0, 48)}${snippet.length > 48 ? "…" : ""}"`,
      },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "key_press", targetId: t, keys: "Enter", description: "Submit with Enter" },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "wait", targetId: t, durationMs: 1500, description: "Wait for response" },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "read_screen", targetId: t, description: "Capture result" },
    },
  ];
}

/**
 * REAL LOCAL mode plan (Milestone 2): observation only. Input actions on the real
 * desktop are limited to the guided Notepad test until AI planning lands.
 */
export function planRealObserveSteps(target: DesktopTarget): PlannedStep[] {
  const t = target.id;
  return [
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "read_screen", targetId: t, description: "Capture real desktop screenshot" },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "wait", targetId: t, durationMs: 1000, description: "Wait 1 second" },
    },
    {
      id: sid(),
      requiresApproval: false,
      action: { kind: "read_screen", targetId: t, description: "Capture follow-up screenshot" },
    },
  ];
}

const INPUT_ACTIONS: ActionKind[] = [
  "launch_app",
  "focus_window",
  "click",
  "type_text",
  "key_press",
  "copy_selection",
  "paste",
];

// Gemini often writes the Windows key as "win" (PyAutoGUI's name); the
// allowlists use "windows". Normalize before validation so both spellings work.
function normalizeKeyAction(action: ProviderResult["steps"][number]["action"]) {
  if (action.kind !== "key_press" || !action.keys) return action;
  const keys = action.keys
    .split("+")
    .map((part) => (part.trim().toLowerCase() === "win" ? "windows" : part))
    .join("+");
  return { ...action, keys };
}

export function normalizeProviderPlan(
  result: ProviderResult,
  target: DesktopTarget,
  supportedActions?: readonly string[],
): PlannedStep[] {
  if (!result.steps.length) throw new Error("The provider returned an empty task plan.");
  if (result.steps.length > 12) throw new Error("The provider returned too many task steps.");

  return result.steps.map((step, index) => {
    const action = normalizeKeyAction(step.action);
    if (action.targetId !== target.id)
      throw new Error(`Plan step ${index + 1} targets an unselected desktop.`);
    if (
      supportedActions &&
      action.kind !== "read_screen" &&
      !supportedActions.includes(action.kind)
    ) {
      throw new Error(`Plan step ${index + 1} uses unsupported worker action "${action.kind}".`);
    }
    if (step.verification?.kind === "text_match" && !step.verification.expectedText?.trim())
      throw new Error(`Plan step ${index + 1} uses text_match verification without expected text.`);
    if (target.interactionMode === "observe_only" && INPUT_ACTIONS.includes(action.kind))
      throw new Error(`Target "${target.displayName}" only permits observation.`);
    const validation = validateAction(action);
    if (!validation.ok && !supportedActions?.includes(action.kind)) throw new Error(
      `Plan step ${index + 1} uses unsupported worker action "${action.kind}". Supported: ${supportedActions?.join(", ")}`
    );

    const policyRequiresApproval =
      target.interactionMode !== "autonomous" && INPUT_ACTIONS.includes(action.kind);
    return {
      id: sid(),
      action,
      requiresApproval: policyRequiresApproval || step.requiresApproval,
      verification: step.verification ?? {
        kind: step.action.kind === "read_screen" ? "screen_capture" : "worker_ok",
      },
    };
  });
}
