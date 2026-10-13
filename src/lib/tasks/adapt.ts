// Module 4 — see-and-adapt loop: pure rules for screen checks, approved scope and replanning.
import type { ActionKind, PlannedStep } from "@/lib/types";

export const MAX_REPLANS = 3;
export const MAX_TOTAL_STEPS = 20;
export const CHECK_TIMEOUT_MS = 15_000;
export const MAX_CHECK_IMAGE_CHARS = 1_500_000;

export type CheckVerdict = "ok" | "off_track" | "unsure";
export interface StepCheckResult {
  verdict: CheckVerdict;
  reason: string;
  screenSummary: string;
  /** Set when the AI quota was hit; the runner pauses checks for the task to save quota. */
  rateLimited?: boolean;
}

/** Read "retry in 58.03s" style hints from quota errors; capped so a task never stalls long. */
export function parseRetryAfterSeconds(message: string, cap = 65): number | null {
  const m = message.match(/retry in ([\d.]+)\s*s/i);
  if (!m) return null;
  return Math.min(cap, Math.ceil(Number(m[1])));
}

/** What the user approved before start. Replanned steps may never go outside it. */
export interface ApprovedScope {
  targetId: string;
  kinds: ActionKind[];
  keys: string[];
  texts: string[];
}

/** Harmless kinds that are always allowed in a replan. */
const ALWAYS_ALLOWED: ActionKind[] = ["read_screen", "wait"];
/** Actions that change the screen and therefore get a check afterwards. */
const CHECKED_KINDS: ActionKind[] = [
  "focus_window",
  "click",
  "type_text",
  "key_press",
  "paste",
];

export const shouldCheckAfter = (kind: ActionKind) => CHECKED_KINDS.includes(kind);

export function approvedScopeFrom(steps: PlannedStep[], targetId: string): ApprovedScope {
  const kinds = new Set<ActionKind>();
  const keys = new Set<string>();
  const texts = new Set<string>();
  for (const s of steps) {
    kinds.add(s.action.kind);
    if (s.action.kind === "key_press" && s.action.keys) keys.add(s.action.keys.toLowerCase());
    if (s.action.kind === "type_text" && s.action.text !== undefined) texts.add(s.action.text);
  }
  return { targetId, kinds: [...kinds], keys: [...keys], texts: [...texts] };
}

export function isWithinApprovedScope(
  steps: PlannedStep[],
  scope: ApprovedScope,
): { ok: true } | { ok: false; reason: string } {
  for (const [i, s] of steps.entries()) {
    const a = s.action;
    const n = i + 1;
    if (a.targetId !== scope.targetId)
      return { ok: false, reason: `new step ${n} targets a different desktop` };
    if (ALWAYS_ALLOWED.includes(a.kind)) continue;
    if (!scope.kinds.includes(a.kind))
      return { ok: false, reason: `new step ${n} uses an unapproved action (${a.kind})` };
    if (a.kind === "key_press" && !scope.keys.includes((a.keys ?? "").toLowerCase()))
      return { ok: false, reason: `new step ${n} presses an unapproved key (${a.keys})` };
    if (a.kind === "type_text" && !scope.texts.includes(a.text ?? ""))
      return { ok: false, reason: `new step ${n} types text you didn't approve` };
  }
  return { ok: true };
}

/** Keep finished steps (0..doneIndex), replace everything after with the new remaining steps. */
export function mergeRemaining(
  steps: PlannedStep[],
  doneIndex: number,
  remaining: PlannedStep[],
): { ok: true; steps: PlannedStep[] } | { ok: false; reason: string } {
  const kept = steps.slice(0, doneIndex + 1).map((s, i) => (i === doneIndex ? { ...s, done: true } : s));
  const merged = [...kept, ...remaining.map((s) => ({ ...s, approved: true }))];
  if (merged.length > MAX_TOTAL_STEPS)
    return { ok: false, reason: `the adjusted plan would exceed ${MAX_TOTAL_STEPS} steps` };
  return { ok: true, steps: merged };
}

export const canReplan = (replans: number | undefined) => (replans ?? 0) < MAX_REPLANS;

/** Strictly parse a check answer (server and client both use this). */
export function parseCheckResult(payload: unknown): StepCheckResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (p["verdict"] !== "ok" && p["verdict"] !== "off_track" && p["verdict"] !== "unsure")
    return null;
  if (typeof p["reason"] !== "string") return null;
  const summary = typeof p["screenSummary"] === "string" ? p["screenSummary"] : "";
  return {
    verdict: p["verdict"],
    reason: p["reason"].slice(0, 300),
    screenSummary: summary.slice(0, 400),
  };
}

/** Context lines for a "continue from here" replan (fits the plan route's 12 x 500 limit). */
export function buildReplanContext(
  steps: PlannedStep[],
  doneIndex: number,
  check: StepCheckResult,
): string[] {
  const done = steps
    .slice(0, doneIndex + 1)
    .map((s, i) => `${i + 1}. ${s.action.description}`)
    .join("; ");
  return [
    "REPLAN: the task is already in progress. Plan ONLY the remaining steps from the current screen.",
    `Steps already done: ${done}`.slice(0, 500),
    `Current screen: ${check.screenSummary || "unknown"}`.slice(0, 500),
    `Problem after the last step: ${check.reason}`.slice(0, 500),
    "Reuse only the same kinds of actions, keys and typed text as the original plan.",
  ];
}
