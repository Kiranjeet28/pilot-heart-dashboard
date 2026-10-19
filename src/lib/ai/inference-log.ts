export type InferencePurpose = "decomposition" | "planning" | "repair" | "completion";

export interface InferenceTiming {
  purpose: InferencePurpose;
  durationMs: number;
  timeToFirstTokenMs?: number | undefined;
  promptTokens?: number | undefined;
  generatedTokens?: number | undefined;
  valid: boolean;
  validationError?: string | undefined;
}

function compactTiming(t: InferenceTiming): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    purpose: t.purpose,
    durationMs: t.durationMs,
    valid: t.valid,
  };
  if (t.timeToFirstTokenMs !== undefined) out["timeToFirstTokenMs"] = t.timeToFirstTokenMs;
  if (t.promptTokens !== undefined) out["promptTokens"] = t.promptTokens;
  if (t.generatedTokens !== undefined) out["generatedTokens"] = t.generatedTokens;
  if (t.validationError) out["validationError"] = t.validationError.slice(0, 500);
  return out;
}

/** Logs inference metrics only. Never pass headers, tokens, or request bodies. */
export function logInferenceTiming(timing: InferenceTiming): void {
  console.info("[DesktopPilot inference]", compactTiming(timing));
}
