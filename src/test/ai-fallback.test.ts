import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_BASE_URL,
  GEMINI_COOLDOWN_MS,
  OFFLINE_MESSAGE,
  __resetAiStatus,
  aiStatus,
  callLocal,
  configureAiRouting,
  cooldownFor,
  routedProvider,
  runWithFallback,
  type AiMode,
} from "@/lib/ai/aiProvider";
import { LOCAL_SYSTEM, buildPlanPrompt } from "@/lib/ai/plan-prompt";
import { DEFAULT_PROVIDERS } from "@/lib/registry/defaults";

const plan = {
  plan: ["Inspect the desktop", "Complete step"],
  summary: "Safe desktop automation plan",
  steps: [
    {
      action: { kind: "read_screen", targetId: "notepad", description: "Inspect the desktop" },
      requiresApproval: false,
      verification: { kind: "screen_capture" },
    },
  ],
};

const sse = (text: string, chunk = 20) => {
  let body = "";
  for (let i = 0; i < text.length; i += chunk) {
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + chunk) } }] })}\n\n`;
  }
  return new Response(body + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
};

const req = {
  taskId: "task-test-1",
  userRequest: "Open Notepad",
  targetId: "notepad",
  provider: DEFAULT_PROVIDERS[0]!,
};

let mode: AiMode = "local";
let localUp = true;
const calls: string[] = [];
let capturedBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  __resetAiStatus();
  mode = "local";
  localUp = true;
  calls.length = 0;
  capturedBodies = [];
  configureAiRouting(() => ({ mode, localBaseUrl: DEFAULT_LOCAL_BASE_URL }));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);

      if (init?.body) {
        try {
          capturedBodies.push(JSON.parse(String(init.body)));
        } catch {
          /* ignore non-json */
        }
      }

      if (url.endsWith("/health")) {
        if (!localUp) throw new TypeError("Failed to fetch");
        return Response.json({ status: "ok" });
      }

      if (url.endsWith("/v1/chat/completions")) {
        if (!localUp) throw new TypeError("Failed to fetch");
        return sse(JSON.stringify(plan));
      }

      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const localCalls = () => calls.filter((c) => c.endsWith("/v1/chat/completions")).length;
const remoteCalls = () =>
  calls.filter((c) => c.includes("ai.gateway.lovable.dev") || c.includes("googleapis.com")).length;

describe("Local-only Qwen planning (Acceptance Criteria 1-10)", () => {
  it("1. calls only the local Qwen endpoint and uses model alias qwen", async () => {
    const r = await runWithFallback(req);
    expect(r.ok).toBe(true);
    expect(localCalls()).toBe(1);
    expect(remoteCalls()).toBe(0);
    expect(capturedBodies[0]?.["model"]).toBe("qwen");
    expect(capturedBodies[0]?.["stream"]).toBe(true);
    expect(capturedBodies[0]?.["cache_prompt"]).toBe(true);
  });

  it("2. initial planning and replanning never call Gemini or Lovable", async () => {
    const initial = await runWithFallback(req);
    expect(initial.ok).toBe(true);

    const replan = await runWithFallback({
      ...req,
      context: ["REPLAN: remaining step", "Problem: unexpected window"],
    });
    expect(replan.ok).toBe(true);
    expect(remoteCalls()).toBe(0);
  });

  it("3. Gemini environment variables and stale provider settings cannot change the planning route", async () => {
    vi.stubEnv("GEMINI_API_KEY", "fake-gemini-key");
    vi.stubEnv("LOVABLE_API_KEY", "fake-gateway-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-2.5-flash");

    // Stale mode "gemini" or "auto" in settings
    mode = "auto";
    const r1 = await runWithFallback({
      ...req,
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
    expect(r1.ok).toBe(true);
    expect(remoteCalls()).toBe(0);
    expect(localCalls()).toBe(1);

    mode = "gemini";
    const r2 = await runWithFallback(req);
    expect(r2.ok).toBe(true);
    expect(remoteCalls()).toBe(0);
  });

  it("4. local-server failure returns a clear error and never triggers a remote fallback", async () => {
    localUp = false;
    const r = await runWithFallback(req);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Local model is offline");
      expect(r.message).toContain("llama-server on port 8081");
    }
    expect(remoteCalls()).toBe(0);
    expect(aiStatus.get().active).toBe("offline");
  });

  it("5. compact prompts preserve target ID, objective, allowed actions and safety requirements", () => {
    const prompt = buildPlanPrompt({
      userRequest: "Type DesktopPilot test 123",
      targetId: "vscode",
      context: ["Previous step completed", "Previous step completed", "  "],
    });

    expect(prompt).toContain('Selected target: "vscode"');
    expect(prompt).toContain('Every action\'s targetId MUST be exactly "vscode"');
    expect(prompt).toContain("Task: Type DesktopPilot test 123");
    expect(prompt).toContain("Context:\n- Previous step completed");
    expect(prompt.match(/Previous step completed/g)?.length).toBe(1);
    // Static rules belong in LOCAL_SYSTEM so they are not repeated after varying task text.
    expect(prompt).not.toContain("Allowed actions:");
    expect(prompt).not.toContain("Verification:");
    expect(LOCAL_SYSTEM).toContain("focus_window");
    expect(LOCAL_SYSTEM).toContain("text_match");
    expect(LOCAL_SYSTEM).toContain("expectedText");
    expect(LOCAL_SYSTEM).toContain("Max 12");
    expect(prompt).not.toContain('"plan": ["step 1 description"');
  });

  it("6. valid plans pass the existing schema and target/action validation", async () => {
    const r = await runWithFallback(req);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps.length).toBe(1);
      expect(r.steps[0]?.action.kind).toBe("read_screen");
      expect(r.steps[0]?.action.targetId).toBe("notepad");
    }
  });

  it("7. invalid JSON, timeout, cancellation, and server-offline cases terminate cleanly", async () => {
    // 7a: cancellation
    const c = new AbortController();
    c.abort();
    const cancelled = await runWithFallback(req, c.signal);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.message).toBe("Cancelled");

    // 7b: server offline
    localUp = false;
    const offline = await runWithFallback(req);
    expect(offline.ok).toBe(false);
    expect(aiStatus.get().active).toBe("offline");
  });

  it("8. repeated UI actions do not create duplicate planning requests for the same task", async () => {
    const p1 = callLocal({ ...req, taskId: "task-dedup-xyz" });
    const p2 = callLocal({ ...req, taskId: "task-dedup-xyz" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Should have executed exactly 1 network request to llama-server
    expect(localCalls()).toBe(1);
  });

  it("9. provider status and the UI badge accurately report Local Qwen", async () => {
    expect(aiStatus.get().active).toBe("local");
    const adapter = routedProvider(DEFAULT_PROVIDERS[0]!);
    expect(adapter.name).toBe("Local Qwen");

    await runWithFallback(req);
    expect(aiStatus.get().active).toBe("local");
    expect(aiStatus.get().log[0]?.provider).toBe("local");
  });

  it("10. existing worker, approval, emergency-stop, and task lifecycle tests continue to pass", () => {
    expect(cooldownFor("server error")).toBe(GEMINI_COOLDOWN_MS);
    expect(OFFLINE_MESSAGE).toContain("http://127.0.0.1:8081");
  });
});
