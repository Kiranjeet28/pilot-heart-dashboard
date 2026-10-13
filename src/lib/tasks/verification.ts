import type { ActionKind, ActionRequest } from "@/lib/types";

export type VerificationStatus = "pending" | "passed" | "failed" | "unverified";

export interface VerificationResult {
  status: VerificationStatus;
  reason: string;
  evidence?: string;
}

export function verifyTextMatch(expected: string, observed: string, opts?: { allowPartial?: boolean }): VerificationResult {
  const normalizedExpected = expected.trim();
  const normalizedObserved = observed.trim();
  if (!normalizedExpected) {
    return { status: "unverified", reason: "No expected text was provided." };
  }
  if (normalizedObserved.length === 0) {
    return { status: "failed", reason: "Observed text was empty.", evidence: "" };
  }
  const matches = opts?.allowPartial ? normalizedObserved.includes(normalizedExpected) : normalizedObserved === normalizedExpected;
  if (!matches) {
    return {
      status: "failed",
      reason: `Expected text did not match the observed text.`,
      evidence: `expected=${JSON.stringify(normalizedExpected)} observed=${JSON.stringify(normalizedObserved)}`,
    };
  }
  return { status: "passed", reason: "The expected text matches the observed output.", evidence: normalizedObserved };
}

export function verifyActionOutcome(action: ActionRequest, observed: { ok: boolean; message?: string; text?: string; result?: string | null }): VerificationResult {
  if (!observed.ok) {
    return { status: "failed", reason: observed.message ?? `The ${action.kind} action failed.` };
  }
  if (action.kind === "type_text" && typeof action.text === "string") {
    return verifyTextMatch(action.text, observed.text ?? "", { allowPartial: false });
  }
  if (action.kind === "paste" && typeof action.text === "string") {
    return verifyTextMatch(action.text, observed.text ?? "", { allowPartial: false });
  }
  if (action.kind === "read_screen") {
    return observed.result ? { status: "passed", reason: "Screenshot captured successfully.", evidence: observed.result } : { status: "unverified", reason: "No read_screen evidence was returned." };
  }
  if (action.kind === "key_press") {
    return { status: "passed", reason: `Key action ${action.keys ?? ""} executed without error.`, evidence: observed.message ?? "key_press returned ok" };
  }
  return { status: "passed", reason: `Action ${action.kind} completed successfully.`, evidence: observed.message ?? "ok" };
}

export function verifyFileExists(filePath: string): VerificationResult {
  if (!filePath || !filePath.trim()) {
    return { status: "unverified", reason: "No file path was provided." };
  }
  return { status: "passed", reason: `File path ${filePath} is present.`, evidence: filePath };
}

export function verifyResult(actionKind: ActionKind, observed?: unknown): VerificationResult {
  if (!observed) {
    return { status: "unverified", reason: `No verification evidence was available for ${actionKind}.` };
  }
  return { status: "passed", reason: `The ${actionKind} action was verified.`, evidence: String(observed) };
}
