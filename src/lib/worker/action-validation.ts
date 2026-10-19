import type { ActionKind, ActionRequest } from "@/lib/types";
import { ALLOWED_KEYS, MAX_ACTION_TEXT, MAX_WAIT_MS } from "./key-allowlist";

/** Branded type: only produced by validateAction, so workers can't receive unchecked input. */
export type ValidatedActionRequest = ActionRequest & { readonly __validated: true };

const ALLOWED: readonly ActionKind[] = [
  "launch_app",
  "focus_window",
  "read_screen",
  "click",
  "type_text",
  "key_press",
  "wait",
  "copy_selection",
  "paste",
];
const MAX_TEXT = 2000; // demo-mode limit for type_text

const PRINTABLE = /^[\x20-\x7E\n]*$/;

export type ValidationResult =
  { ok: true; action: ValidatedActionRequest } | { ok: false; reason: string };

export interface ValidationContext {
  /** Current screen size from a fresh observation; enables bounds checks. */
  screen?: { width: number; height: number } | undefined;
  /** Real-worker mode applies stricter text rules matching the Python schema. */
  strict?: boolean | undefined;
}

export function validateAction(a: ActionRequest, ctx: ValidationContext = {}): ValidationResult {
  if (!ALLOWED.includes(a.kind))
    return { ok: false, reason: `Action "${String(a.kind)}" is not allowed` };
  if (!a.targetId) return { ok: false, reason: "Action has no desktop target" };
  if (a.kind === "launch_app" && a.app !== "notepad")
    return { ok: false, reason: "launch_app supports only the approved notepad application" };
  const textLimit = ctx.strict ? MAX_ACTION_TEXT : MAX_TEXT;
  if (a.kind === "type_text") {
    if (!a.text) return { ok: false, reason: "type_text requires text" };
    if (a.text.length > textLimit)
      return { ok: false, reason: `Text exceeds ${textLimit} characters` };
    if (ctx.strict && !PRINTABLE.test(a.text))
      return { ok: false, reason: "Text may only contain printable ASCII and newlines" };
  }
  if (a.kind === "paste" && a.text != null) {
    if (a.text.length > MAX_ACTION_TEXT || !PRINTABLE.test(a.text))
      return { ok: false, reason: "Paste text must be ≤500 printable ASCII characters" };
  }
  if (a.kind === "click") {
    if (
      a.x == null ||
      a.y == null ||
      a.x < 0 ||
      a.y < 0 ||
      !Number.isInteger(a.x) ||
      !Number.isInteger(a.y)
    )
      return { ok: false, reason: "click requires non-negative integer coordinates" };
    if (ctx.screen && (a.x >= ctx.screen.width || a.y >= ctx.screen.height))
      return {
        ok: false,
        reason: `Coordinates (${a.x}, ${a.y}) are outside the ${ctx.screen.width}×${ctx.screen.height} screen`,
      };
    if (ctx.strict && !a.observationId)
      return { ok: false, reason: "click requires a fresh observation" };
  }
  if (a.kind === "key_press") {
    if (!a.keys) return { ok: false, reason: "key_press requires keys" };
    if (ctx.strict && !(ALLOWED_KEYS as readonly string[]).includes(a.keys.toLowerCase()))
      return { ok: false, reason: `Key "${a.keys}" is not on the allowlist` };
  }
  if (
    a.kind === "wait" &&
    (a.durationMs == null || a.durationMs < 0 || a.durationMs > (ctx.strict ? MAX_WAIT_MS : 30000))
  )
    return { ok: false, reason: `wait duration must be 0–${ctx.strict ? MAX_WAIT_MS : 30000} ms` };
  return { ok: true, action: { ...a, __validated: true } };
}
