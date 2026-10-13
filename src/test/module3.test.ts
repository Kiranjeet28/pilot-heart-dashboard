import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  MockAIProvider,
  createAIProvider,
  normalizeProviderResponse,
} from "@/lib/ai/provider";
import { handleTaskPlanRequest } from "@/lib/server/task-plan";
import { canTransition } from "@/lib/tasks/state-machine";
import { createTask, transitionTask } from "@/lib/tasks/task-manager";
import { verifyTextMatch } from "@/lib/tasks/verification";

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: vi.fn(async () => ({
        text: JSON.stringify({
          plan: ["Inspect the desktop state", "Confirm the result"],
          summary: "Safe desktop review",
          nextAction: {
            kind: "read_screen",
            targetId: "desktop",
            description: "Inspect the desktop state",
          },
          requiresApproval: false,
        }),
      })),
    };
  },
}));

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
    const task = createTask({
      description: "Test task",
      providerId: "gemini",
      profileId: "personal",
      targetId: "vscode",
    });
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
    const result = await adapter.getNextStep({
      userRequest: "Open a text editor",
      provider: {
        id: "gemini",
        displayName: "Google Gemini",
        type: "gemini",
        connectionMethod: "api_key",
        model: "gemini-2.5-flash",
        enabled: true,
        connectionStatus: "configured_unverified",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextAction?.kind).toBe("read_screen");
  });

  it("handles provider failures and malformed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: "too many requests" }),
      }),
    );
    const provider = new GeminiProvider();
    const result = await provider.getNextStep({
      userRequest: "do work",
      provider: {
        id: "gemini",
        displayName: "Google Gemini",
        type: "gemini",
        connectionMethod: "api_key",
        model: "gemini-2.5-flash",
        enabled: true,
        connectionStatus: "configured_unverified",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rate_limit");

    const parsed = normalizeProviderResponse({
      plan: ["a"],
      summary: "ok",
      nextAction: { kind: "read_screen", targetId: "desktop", description: "inspect" },
    });
    expect(parsed.ok).toBe(true);
    expect(() => normalizeProviderResponse({ plan: "bad" } as never)).toThrow();
  });
});

describe("secure Gemini task-plan endpoint", () => {
  const originalToken = process.env.DESKTOPPILOT_SERVER_TOKEN;
  const originalKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DESKTOPPILOT_SERVER_TOKEN;
    else process.env.DESKTOPPILOT_SERVER_TOKEN = originalToken;

    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;

    vi.unstubAllGlobals();
  });

  it("rejects cross-site requests and missing configuration", async () => {
    delete process.env.DESKTOPPILOT_SERVER_TOKEN;
    delete process.env.GEMINI_API_KEY;

    const response = await handleTaskPlanRequest(
      new Request("https://example.com/api/tasks/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ userRequest: "Open the README" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("allows same-origin browser requests without embedding secrets", async () => {
    delete process.env.DESKTOPPILOT_SERVER_TOKEN;
    process.env.GEMINI_API_KEY = "test-gemini-key";

    const response = await handleTaskPlanRequest(
      new Request("http://localhost:3000/api/tasks/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ userRequest: "Open the README" }),
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
  });

  it("accepts a configured backend token for internal clients", async () => {
    process.env.DESKTOPPILOT_SERVER_TOKEN = "server-token-123";
    process.env.GEMINI_API_KEY = "test-gemini-key";

    const response = await handleTaskPlanRequest(
      new Request("http://localhost:3000/api/tasks/plan", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer server-token-123",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ userRequest: "Open the README" }),
      }),
    );

    expect(response.status).toBe(200);
  });

  it("does not expose browser secrets in frontend source", () => {
    const providerSource = readFileSync(resolve("src/lib/ai/provider.ts"), "utf8");
    expect(providerSource).not.toMatch(
      /VITE_GEMINI_API_KEY|desktoppilot_server_token|import\.meta\.env|sessionStorage/i,
    );
  });
});
