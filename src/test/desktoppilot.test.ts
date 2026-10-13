import { describe, expect, it } from "vitest";
import { canTransition } from "@/lib/tasks/state-machine";
import { validateAction } from "@/lib/worker/action-validation";
import { MockDesktopWorker } from "@/lib/worker/mock-worker";
import { checkReadiness } from "@/lib/safety/readiness";
import { DEFAULT_PROFILES, DEFAULT_PROVIDERS, DEFAULT_TARGETS } from "@/lib/registry/defaults";

describe("task state machine", () => {
  it("terminal states cannot resume", () => {
    expect(canTransition("cancelled", "running")).toBe(false);
    expect(canTransition("completed", "queued")).toBe(false);
  });
  it("paused can resume to running", () => expect(canTransition("paused", "running")).toBe(true));
  it("approval wait cannot be paused", () => expect(canTransition("waiting_for_approval", "paused")).toBe(false));
});

describe("action validation", () => {
  it("rejects non-allowlisted actions like shell", () => {
    expect(validateAction({ kind: "shell" as never, targetId: "vscode", description: "x" }).ok).toBe(false);
  });
  it("rejects negative click coordinates", () => {
    expect(validateAction({ kind: "click", targetId: "vscode", x: -1, y: 5, description: "x" }).ok).toBe(false);
  });
});

describe("mock worker", () => {
  it("marks every result as simulated", async () => {
    const w = new MockDesktopWorker({ isConnected: () => true, failureRate: () => 0 });
    const v = validateAction({ kind: "focus_window", targetId: "vscode", description: "x" });
    if (!v.ok) throw new Error();
    expect((await w.executeAction("t", v.action)).simulated).toBe(true);
  });
  it("throws when disconnected", async () => {
    const w = new MockDesktopWorker({ isConnected: () => false, failureRate: () => 0 });
    await expect(w.observe({ taskId: "t", targetId: "v", targetLabel: "v" })).rejects.toThrow();
  });
});

describe("readiness", () => {
  const base = { providerId: "gemini", profileId: "personal", targetId: "vscode", providers: DEFAULT_PROVIDERS, profiles: DEFAULT_PROFILES, targets: DEFAULT_TARGETS, tasks: [], emergencyStop: false, worker: "connected" as const };
  it("ready with valid config", () => expect(checkReadiness(base)).toEqual([]));
  it("blocked by emergency stop", () => expect(checkReadiness({ ...base, emergencyStop: true }).length).toBeGreaterThan(0));
  it("blocked by disabled provider", () => expect(checkReadiness({ ...base, providerId: "anthropic", profileId: "" }).some((i) => i.includes("disabled"))).toBe(true));
});
