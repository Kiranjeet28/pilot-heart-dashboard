import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider, MockAIProvider, createAIProvider, normalizeProviderResponse } from "@/lib/ai/provider";
import { canTransition } from "@/lib/tasks/state-machine";
import { createTask, transitionTask } from "@/lib/tasks/task-manager";
import { verifyTextMatch } from "@/lib/tasks/verification";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task manager and verification", () => {
  it("supports alias approval and verification states", () => {
    expect(canTransition("running", "awaiting_approval")).toBe(true);
    expect(canTransition("awaiting_approval", "running")).toBe(true);
    expect(canTransition("running", "verifying")).toBe(true);
  });

  it("creates a task with a draft lifecycle", () => {
    const task = createTask({ description: "Test task", providerId: "gemini", profileId: "personal", targetId: "vscode" });
    expect(task.status).toBe("draft");
    expect(task.description).toBe("Test task");
    expect(() => transitionTask(task, "completed")).toThrow();
  });

  it("records verification results when text matches", () => {
    const result = verifyTextMatch("hello", "hello");
    expect(result.status).toBe("passed");
  });
});

describe("AI provider adapter", () => {
  it("provides a mock provider for safe testing", async () => {
    const adapter = new MockAIProvider();
    const result = await adapter.getNextStep({ userRequest: "Open a text editor", provider: { id: "gemini", displayName: "Google Gemini", type: "gemini", connectionMethod: "api_key", model: "gemini-2.5-flash", enabled: true, connectionStatus: "configured_unverified" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextAction?.kind).toBe("read_screen");
  });

  it("handles provider failures and malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "too many requests" }) }));
    const provider = new GeminiProvider();
    const result = await provider.getNextStep({ userRequest: "do work", provider: { id: "gemini", displayName: "Google Gemini", type: "gemini", connectionMethod: "api_key", model: "gemini-2.5-flash", enabled: true, connectionStatus: "configured_unverified" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limit");

    const parsed = normalizeProviderResponse({ plan: ["a"], summary: "ok", nextAction: { kind: "read_screen", targetId: "desktop", description: "inspect" } });
    expect(parsed.ok).toBe(true);
    expect(() => normalizeProviderResponse({ plan: "bad" } as never)).toThrow();
  });
});
