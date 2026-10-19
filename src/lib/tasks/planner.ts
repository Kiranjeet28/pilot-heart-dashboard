import type { ProviderResult } from "@/lib/ai/provider";
import { validateAction } from "@/lib/worker/action-validation";
import type { ActionKind, DesktopTarget, PlannedStep } from "@/lib/types";

let n = 0;
const sid = () => `step_${Date.now().toString(36)}_${(n++).toString(36)}`;

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
    .map((part) => {
      const key = part.trim().toLowerCase();
      return key === "win" ? "windows" : key;
    })
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
    if (!validation.ok)
      throw new Error(`Plan step ${index + 1} is invalid: ${validation.reason}`);

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
