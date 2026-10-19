/**
 * Heuristic for tasks that can be planned in a single short batch.
 * Does not special-case applications or hardcode actions.
 */
const SEQUENCE = /\b(then|after that|afterwards|next|finally|followed by)\b/i;
const AND_THEN = /\band then\b/i;
const NUMBERED = /^\s*\d+[.)]/m;
const MULTI_SENTENCE = /[.!?][^.!?]+[.!?]/;

export function isSimpleDesktopTask(objective: string): boolean {
  const text = objective.trim();
  if (!text || text.length > 80) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  if (text.includes("\n")) return false;
  if (NUMBERED.test(text)) return false;
  if (AND_THEN.test(text) || SEQUENCE.test(text)) return false;
  const andCount = (text.match(/\band\b/gi) ?? []).length;
  if (andCount >= 2) return false;
  if (MULTI_SENTENCE.test(text)) return false;
  return true;
}

const MUTATING_KINDS = new Set(["click", "type_text", "key_press", "paste", "copy_selection"]);

/** True when a simple task already performed a mutating action and observation succeeded. */
export function simpleTaskHasDeterministicProgress(
  originalObjective: string,
  executedKinds: string[],
  observationOk: boolean,
): boolean {
  if (!isSimpleDesktopTask(originalObjective)) return false;
  if (!observationOk) return false;
  return executedKinds.some((kind) => MUTATING_KINDS.has(kind));
}
