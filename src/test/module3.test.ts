import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiProvider,
  MockAIProvider,
  createAIProvider,
  normalizeProviderResponse,
} from "@/lib/ai/provider";
import { handleTaskPlanRequest, isRateLimited } from "@/lib/server/task-plan";
import { canTransition } from "@/lib/tasks/state-machine";
import { createTask, transitionTask } from "@/lib/tasks/task-manager";
import { normalizeProviderPlan } from "@/lib/tasks/planner";
import { verifyActionOutcome, verifyTextMatch } from "@/lib/tasks/verification";
import { DEFAULT_TARGETS } from "@/lib/registry/defaults";

const mockGenaiState = vi.hoisted(() => ({
  response: {
    plan: ["Inspect the desktop state", "Confirm the result"],
    summary: "Safe desktop review",
    nextAction: {
      kind: "read_screen",
      targetId: "desktop",
      description: "Inspect the desktop state",
    },
    requiresApproval: false,
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: vi.fn(async () => ({
        text: JSON.stringify(mockGenaiState.response),
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

  it("normalizes provider steps and applies assisted-target approval", () => {
    const result = normalizeProviderPlan(
      {
        ok: true,
        plan: ["Type a harmless sentence"],
        summary: "Type a sentence",
        steps: [
          {
            action: {
              kind: "type_text",
              targetId: "vscode",
              text: "hello",
              description: "Type hello",
            },
            requiresApproval: false,
            verification: { kind: "worker_ok" },
          },
        ],
      },
      DEFAULT_TARGETS[0]!,
      ["type_text"],
    );
    expect(result[0]?.requiresApproval).toBe(true);
  });

  it("does not treat a failed worker result as verified", () => {
    const result = verifyActionOutcome(
      { kind: "click", targetId: "vscode", x: 1, y: 1, description: "Click" },
      { ok: false, message: "worker stopped" },
      { kind: "worker_ok" },
    );
    expect(result.status).toBe("failed");
  });

  it("marks text_match as unverified when the worker supplies no observed text", () => {
    const result = verifyActionOutcome(
      { kind: "type_text", targetId: "vscode", text: "hi", description: "Type" },
      { ok: true, message: "typed" },
      { kind: "text_match", expectedText: "hello" },
    );
    expect(result.status).toBe("unverified");
    expect(verifyTextMatch("hello", "").status).toBe("unverified");
  });

  it("rejects text_match verification without expected text in plans", () => {
    expect(() =>
      normalizeProviderPlan(
        {
          ok: true,
          plan: ["Type text"],
          summary: "Type text",
          steps: [
            {
              action: {
                kind: "type_text",
                targetId: "vscode",
                text: "hello",
                description: "Type hello",
              },
              requiresApproval: false,
              verification: { kind: "text_match" },
            },
          ],
        },
        DEFAULT_TARGETS[0]!,
        ["type_text"],
      ),
    ).toThrow(/text_match/);
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
  const originalToken = process.env["DESKTOPPILOT_SERVER_TOKEN"];
  const originalKey = process.env["GEMINI_API_KEY"];

  afterEach(() => {
    if (originalToken === undefined) delete process.env["DESKTOPPILOT_SERVER_TOKEN"];
    else process.env["DESKTOPPILOT_SERVER_TOKEN"] = originalToken;

    if (originalKey === undefined) delete process.env["GEMINI_API_KEY"];
    else process.env["GEMINI_API_KEY"] = originalKey;

    vi.unstubAllGlobals();
  });

  it("rejects cross-site requests and missing configuration", async () => {
    delete process.env["DESKTOPPILOT_SERVER_TOKEN"];
    delete process.env["GEMINI_API_KEY"];

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
    delete process.env["DESKTOPPILOT_SERVER_TOKEN"];
    process.env["GEMINI_API_KEY"] = "test-gemini-key";

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
    process.env["DESKTOPPILOT_SERVER_TOKEN"] = "server-token-123";
    process.env["GEMINI_API_KEY"] = "test-gemini-key";

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

  const postPlan = (
    body: unknown,
    headers: Record<string, string> = {},
    url = "http://localhost:3000/api/tasks/plan",
  ) =>
    handleTaskPlanRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("rejects requests with no origin evidence (missing headers are not trust)", async () => {
    delete process.env["DESKTOPPILOT_SERVER_TOKEN"];
    const response = await postPlan(
      { userRequest: "Open the README" },
      { "sec-fetch-site": "same-origin" }, // fetch metadata alone proves nothing
    );
    expect(response.status).toBe(401);
  });

  it("rejects requests from an untrusted origin", async () => {
    delete process.env["DESKTOPPILOT_SERVER_TOKEN"];
    const response = await postPlan(
      { userRequest: "Open the README" },
      { origin: "https://untrusted.example" },
    );
    expect(response.status).toBe(401);
  });

  it("rejects invalid payloads with a 400", async () => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    const response = await postPlan(
      { userRequest: "" },
      { origin: "http://localhost:3000" },
    );
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.code).toBe("invalid_request");
  });

  it("rejects oversized request bodies with a 413", async () => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    const response = await postPlan(
      { userRequest: "y".repeat(70_000) },
      { origin: "http://localhost:3000" },
    );
    expect(response.status).toBe(413);
  });

  it("rejects generated steps that target an unselected desktop", async () => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    const original = mockGenaiState.response;
    mockGenaiState.response = {
      plan: ["Inspect"],
      summary: "Inspect",
      steps: [
        {
          action: { kind: "read_screen", targetId: "wrong-target", description: "Inspect" },
          requiresApproval: false,
          verification: { kind: "screen_capture" },
        },
      ],
    };
    try {
      const response = await postPlan(
        { userRequest: "Open the README", targetId: "vscode" },
        { origin: "http://localhost:3000" },
      );
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.code).toBe("target_mismatch");
    } finally {
      mockGenaiState.response = original;
    }
  });

  it("returns 200 with matching target steps for a valid same-origin request", async () => {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    const original = mockGenaiState.response;
    mockGenaiState.response = {
      plan: ["Inspect the target"],
      summary: "Inspect the target",
      steps: [
        {
          action: { kind: "read_screen", targetId: "vscode", description: "Inspect the target" },
          requiresApproval: false,
          verification: { kind: "screen_capture" },
        },
      ],
    };
    try {
      const response = await postPlan(
        { userRequest: "Open the README", targetId: "vscode" },
        { origin: "http://localhost:3000" },
      );
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.ok).toBe(true);
      expect(json.steps[0].action.targetId).toBe("vscode");
    } finally {
      mockGenaiState.response = original;
    }
  });

  it("rate limits repeated planning requests from one origin", () => {
    const key = "rate-test-origin";
    for (let i = 0; i < 30; i++) expect(isRateLimited(key, 30, 60_000)).toBe(false);
    expect(isRateLimited(key, 30, 60_000)).toBe(true);
    expect(isRateLimited("rate-test-origin-2", 30, 60_000, Date.now() + 61_000)).toBe(false);
  });
});
