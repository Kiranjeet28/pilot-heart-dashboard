import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIProvider, MockAIProvider, OpenAIProvider, normalizeProviderResponse } from "@/lib/ai/provider";
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
    const task = createTask({ description: "Test task", providerId: "openai", profileId: "personal", targetId: "vscode" });
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
    const result = await adapter.getNextStep({ userRequest: "Open a text editor", provider: { id: "mock", displayName: "Mock", type: "openai", connectionMethod: "api_key", model: "gpt-4o-mini", enabled: true, connectionStatus: "configured_unverified" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextAction?.kind).toBe("read_screen");
  });

  it("fails cleanly when credentials are missing", async () => {
    const provider = new OpenAIProvider(undefined, 1000);
    const result = await provider.getNextStep({
      userRequest: "Write a test file",
      provider: { id: "openai", displayName: "OpenAI", type: "openai", connectionMethod: "api_key", model: "gpt-4o-mini", enabled: true, connectionStatus: "configured_unverified" },
      profile: { id: "personal", name: "Personal", providerId: "openai", authMethod: "api_key_ref", credentialRef: "OPENAI_MISSING_KEY", notes: "" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_credentials");
  });

  it("handles rate limits and malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "too many requests" }) }));
    const provider = createAIProvider({ id: "openai", displayName: "OpenAI", type: "openai", connectionMethod: "api_key", model: "gpt-4o-mini", enabled: true, connectionStatus: "configured_unverified" }, undefined, { apiKey: "abc" });
    const result = await provider.getNextStep({ userRequest: "do work", provider: { id: "openai", displayName: "OpenAI", type: "openai", connectionMethod: "api_key", model: "gpt-4o-mini", enabled: true, connectionStatus: "configured_unverified" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limit");

    const parsed = normalizeProviderResponse({ plan: ["a"], summary: "ok", nextAction: { kind: "read_screen", targetId: "desktop", description: "inspect" } });
    expect(parsed.ok).toBe(true);
    expect(() => normalizeProviderResponse({ plan: "bad" } as never)).toThrow();
  });
});
