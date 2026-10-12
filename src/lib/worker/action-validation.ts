import type { ActionKind, ActionRequest } from "@/lib/types";

/** Branded type: only produced by validateAction, so workers can't receive unchecked input. */
export type ValidatedActionRequest = ActionRequest & { readonly __validated: true };

const ALLOWED: readonly ActionKind[] = ["focus_window", "read_screen", "click", "type_text", "key_press", "wait"];
const MAX_TEXT = 2000;

export type ValidationResult = { ok: true; action: ValidatedActionRequest } | { ok: false; reason: string };

export function validateAction(a: ActionRequest): ValidationResult {
  if (!ALLOWED.includes(a.kind)) return { ok: false, reason: `Action "${String(a.kind)}" is not allowed` };
  if (!a.targetId) return { ok: false, reason: "Action has no desktop target" };
  if (a.kind === "type_text") {
    if (!a.text) return { ok: false, reason: "type_text requires text" };
    if (a.text.length > MAX_TEXT) return { ok: false, reason: `Text exceeds ${MAX_TEXT} characters` };
  }
  if (a.kind === "click") {
    if (a.x == null || a.y == null || a.x < 0 || a.y < 0) return { ok: false, reason: "click requires non-negative coordinates" };
  }
  if (a.kind === "key_press" && !a.keys) return { ok: false, reason: "key_press requires keys" };
  if (a.kind === "wait" && (a.durationMs == null || a.durationMs < 0 || a.durationMs > 30000))
    return { ok: false, reason: "wait duration must be 0–30000 ms" };
  return { ok: true, action: { ...a, __validated: true } };
}
