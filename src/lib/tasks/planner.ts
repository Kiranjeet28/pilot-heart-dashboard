// Demo planner: deterministic step plan. Will be replaced by a real AI provider call.
import type { DesktopTarget, PlannedStep } from "@/lib/types";

let n = 0;
const sid = () => `step_${Date.now().toString(36)}_${(n++).toString(36)}`;

export function planDemoSteps(description: string, target: DesktopTarget): PlannedStep[] {
  const t = target.id;
  const snippet = description.trim().slice(0, 120);
  const needsApproval = target.interactionMode !== "autonomous";
  return [
    { id: sid(), requiresApproval: false, action: { kind: "focus_window", targetId: t, description: `Focus window matching "${target.windowTitleContains || target.displayName}"` } },
    { id: sid(), requiresApproval: false, action: { kind: "read_screen", targetId: t, description: "Read current screen state" } },
    { id: sid(), requiresApproval: false, action: { kind: "click", targetId: t, x: 320, y: 240, description: "Click into input area" } },
    { id: sid(), requiresApproval: needsApproval, action: { kind: "type_text", targetId: t, text: snippet, description: `Type task prompt: "${snippet.slice(0, 48)}${snippet.length > 48 ? "…" : ""}"` } },
    { id: sid(), requiresApproval: false, action: { kind: "key_press", targetId: t, keys: "Enter", description: "Submit with Enter" } },
    { id: sid(), requiresApproval: false, action: { kind: "wait", targetId: t, durationMs: 1500, description: "Wait for response" } },
    { id: sid(), requiresApproval: false, action: { kind: "read_screen", targetId: t, description: "Capture result" } },
  ];
}
