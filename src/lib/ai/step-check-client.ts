// Browser client for /api/tasks/check. Any failure becomes "unsure" — never a silent pass.
import { shouldSkipGeminiCheck } from "@/lib/ai/aiProvider";
import { CHECK_TIMEOUT_MS, parseCheckResult, type StepCheckResult } from "@/lib/tasks/adapt";

export interface StepCheckRequest {
  taskId: string;
  targetId: string;
  taskRequest: string;
  stepDescription: string;
  expected?: string;
  imageDataUrl: string;
}

export async function requestStepCheck(req: StepCheckRequest): Promise<StepCheckResult> {
  // Local Qwen is text-only: screen checks are skipped as unsure without remote AI calls.
  if (shouldSkipGeminiCheck()) {
    return {
      verdict: "unsure",
      reason: "Screen check skipped — local Qwen is text-only and does not inspect screenshots",
      screenSummary: "",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS + 2000);
  try {
    const res = await fetch("/api/tasks/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    if (res.status === 429) {
      return { verdict: "unsure", reason: "AI quota reached", screenSummary: "", rateLimited: true };
    }
    if (!res.ok) {
      return {
        verdict: "unsure",
        reason: `Screen check unavailable: ${payload?.message ?? `HTTP ${res.status}`}`,
        screenSummary: "",
      };
    }
    return (
      parseCheckResult(payload) ?? {
        verdict: "unsure",
        reason: "Screen check returned an unexpected answer",
        screenSummary: "",
      }
    );
  } catch {
    return {
      verdict: "unsure",
      reason: controller.signal.aborted ? "Screen check timed out" : "Screen check could not be reached",
      screenSummary: "",
    };
  } finally {
    clearTimeout(timer);
  }
}
