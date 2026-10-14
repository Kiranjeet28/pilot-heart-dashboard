import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_BASE_URL,
  DIAGNOSTIC_HINTS,
  LOCAL_IDLE_TIMEOUT_MS,
  LOCAL_HARD_CAP_MS,
  LOCAL_MAX_TOKENS,
  LOCAL_TOKEN_BUDGET,
  __resetAiStatus,
  aiStatus,
  callLocal,
  configureAiRouting,
  enqueueLocal,
  estimateTokens,
  fitLocalPrompt,
  isLoopbackUrl,
  isGeminiCoolingDown,
  noteGeminiQuotaFromCheck,
  retryGeminiNow,
  runLocalDiagnostics,
  stripImageParts,
  stripThinking,
} from "@/lib/ai/aiProvider";
import {
  LOCAL_SYSTEM,
  PLAN_JSON_SCHEMA,
  buildPlanPrompt,
  uniqueContext,
} from "@/lib/ai/plan-prompt";
import { normalizeProviderResponse } from "@/lib/ai/provider";
import { DEFAULT_PROVIDERS, DEFAULT_SETTINGS } from "@/lib/registry/defaults";

const plan = {
  plan: ["Look"],
  summary: "ok",
  steps: [
    {
      action: { kind: "read_screen", targetId: "notepad", description: "Look" },
      requiresApproval: false,
    },
  ],
};
const req = { userRequest: "Open Notepad", targetId: "notepad", provider: DEFAULT_PROVIDERS[0]! };
const sse = (parts: string[]) =>
  new Response(
    parts
      .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n",
  );
let bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  __resetAiStatus();
  bodies = [];
  configureAiRouting(() => ({ mode: "local", localBaseUrl: DEFAULT_LOCAL_BASE_URL }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubLocal(chat: (body: Record<string, unknown>) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health")) return Response.json({ status: "ok" });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return chat(body);
    }),
  );
}

describe("1. port default", () => {
  it("defaults to 127.0.0.1:8081", () => {
    expect(DEFAULT_LOCAL_BASE_URL).toBe("http://127.0.0.1:8081");
    expect(DEFAULT_SETTINGS.localBaseUrl).toBe("http://127.0.0.1:8081");
  });
  it("accepts only loopback addresses", () => {
    expect(isLoopbackUrl("http://localhost:9000")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:8081")).toBe(false);
    expect(isLoopbackUrl("file:///etc")).toBe(false);
  });
});

describe("2. streaming + timeouts", () => {
  it("uses a 90 s idle timeout and a 15 min hard cap", () => {
    expect(LOCAL_IDLE_TIMEOUT_MS).toBe(90_000);
    expect(LOCAL_HARD_CAP_MS).toBe(900_000);
  });
  it("streams, sends cache_prompt and parses the collected JSON", async () => {
    const t = JSON.stringify(plan);
    stubLocal(() => sse([t.slice(0, 10), t.slice(10)]));
    const r = await callLocal(req);
    expect(r.ok).toBe(true);
    expect(bodies[0]!["stream"]).toBe(true);
    expect(bodies[0]!["cache_prompt"]).toBe(true);
    expect(aiStatus.get().log[0]!.outputTokens).toBe(2);
  });
  it("aborts when no token arrives for 90 seconds", async () => {
    vi.useFakeTimers();
    stubLocal(
      (_b) =>
        new Promise<Response>((_res, rej) => {
          const sig = (vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).signal!;
          sig.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const p = callLocal(req);
    await vi.advanceTimersByTimeAsync(91_000);
    const r = await p;
    expect(!r.ok && r.message).toContain("90 seconds");
  });
});

describe("3. images and cleanup", () => {
  it("strips image parts and keeps text", () => {
    const out = stripImageParts([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "data:x" } },
        ],
      },
    ]);
    expect(out[0]!.content).toBe("hi");
    expect(JSON.stringify(out)).not.toContain("image");
  });
  it("removes <think> blocks before parsing", async () => {
    expect(stripThinking('<think>hmm</think>{"a":1}')).toBe('{"a":1}');
    stubLocal(() => sse(["<think>planning…</think>", JSON.stringify(plan)]));
    expect((await callLocal(req)).ok).toBe(true);
  });
  it("keeps the system prompt first and identical across calls", async () => {
    stubLocal(() => sse([JSON.stringify(plan)]));
    await callLocal(req);
    await callLocal({ ...req, userRequest: "Other" });
    const sys = bodies.map((b) => (b["messages"] as Array<{ role: string; content: string }>)[0]!);
    expect(sys[0]!.role).toBe("system");
    expect(sys[0]!.content).toBe(sys[1]!.content);
  });
});

describe("4. context budget", () => {
  it("estimates tokens as chars / 3.5", () => {
    expect(estimateTokens("x".repeat(35))).toBe(10);
  });
  it("drops oldest history first and keeps the user request", () => {
    const ctx = Array.from({ length: 80 }, (_, i) => `hist-${i} ${"x".repeat(500)}`);
    const p = fitLocalPrompt("Open Notepad", "notepad", ctx)!;
    expect(p).toContain("Open Notepad");
    expect(p).not.toContain("hist-0 ");
    expect(p).toContain("hist-79");
    expect(
      estimateTokens(LOCAL_SYSTEM) + estimateTokens(p) + 250 + LOCAL_MAX_TOKENS,
    ).toBeLessThanOrEqual(LOCAL_TOKEN_BUDGET);
  });
  it("dedupes identical context lines before fitting", () => {
    expect(uniqueContext(["A", " a ", "", "B", "A"])).toEqual(["B", "A"]);
    const p = fitLocalPrompt("Open Notepad", "notepad", ["same note", "same note", "newer"])!;
    expect(p.match(/same note/g)?.length).toBe(1);
    expect(p).toContain("newer");
  });
  it("refuses to send when the request itself cannot fit", async () => {
    stubLocal(() => sse([JSON.stringify(plan)]));
    const r = await callLocal({ ...req, userRequest: "x".repeat(30000) });
    expect(!r.ok && r.message).toContain("too large");
    expect(bodies.length).toBe(0);
  });
});

describe("5. one local request at a time", () => {
  it("runs local jobs sequentially", async () => {
    const order: string[] = [];
    const slow = enqueueLocal(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
    });
    const fast = enqueueLocal(async () => order.push("b"));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
  it("cancelling aborts the in-flight local call", async () => {
    stubLocal(
      () =>
        new Promise<Response>((_res, rej) => {
          const sig = (vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).signal!;
          sig.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const c = new AbortController();
    const p = callLocal(req, c.signal);
    await new Promise((r) => setTimeout(r, 5));
    c.abort();
    const r = await p;
    expect(!r.ok && r.message).toBe("Cancelled");
  });
});

describe("6. validation", () => {
  it("retries once with a reminder, then reports the error", async () => {
    stubLocal(() => sse(['{"steps":"nope"}']));
    const r = await callLocal(req);
    expect(r.ok).toBe(false);
    expect(bodies.length).toBe(2);
    const last = bodies[1]!["messages"] as Array<{ content: string }>;
    expect(last.at(-1)!.content).toBe("Return only valid JSON matching the schema.");
  });
});

describe("7. diagnostics", () => {
  it("reports a working model with tokens/sec", async () => {
    stubLocal(() => sse(["O", "K"]));
    const d = await runLocalDiagnostics();
    expect(d.failure).toBeNull();
    expect(d.chat?.tokens).toBe(2);
  });
  it("flags CORS/browser block when only no-cors reaches the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        if (init?.mode === "no-cors") return new Response(null);
        throw new TypeError("Failed to fetch");
      }),
    );
    const d = await runLocalDiagnostics();
    expect(d.failure).toBe("cors_or_browser_block");
    expect(d.hint).toBe(DIAGNOSTIC_HINTS.cors_or_browser_block);
  });
  it("flags server not running when nothing answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect((await runLocalDiagnostics()).failure).toBe("server_not_running");
  });
});

describe("8. manual controls", () => {
  it("Retry Gemini now clears the cooldown", () => {
    configureAiRouting(() => ({ mode: "auto", localBaseUrl: DEFAULT_LOCAL_BASE_URL }));
    noteGeminiQuotaFromCheck();
    expect(isGeminiCoolingDown()).toBe(true);
    retryGeminiNow();
    expect(isGeminiCoolingDown()).toBe(false);
  });
});

describe("9. request log", () => {
  it("records latency, tokens and tokens/sec for local calls", async () => {
    stubLocal(() => sse([JSON.stringify(plan)]));
    await callLocal(req, undefined, "Gemini quota");
    const e = aiStatus.get().log[0]!;
    expect(e.provider).toBe("local");
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
    expect(e.outputTokens).toBe(1);
    expect(e.fallbackReason).toBe("Gemini quota");
  });
});

const schemaOverhead = 250;

function inputTokens(userRequest: string, targetId: string, context: string[] = []) {
  const prompt = buildPlanPrompt({ userRequest, targetId, context });
  return estimateTokens(LOCAL_SYSTEM) + estimateTokens(prompt) + schemaOverhead;
}

describe("10. planning prompt token reductions", () => {
  it("simple requests omit duplicated static rules from the user prompt", () => {
    const prompt = buildPlanPrompt({ userRequest: "Open Notepad", targetId: "notepad" });
    expect(prompt.startsWith('Selected target: "notepad"')).toBe(true);
    expect(prompt).toContain("Task: Open Notepad");
    expect(prompt).not.toContain("Allowed actions:");
    expect(prompt.split("\n").length).toBe(2);
    const previousUser =
      'Selected target: "notepad". Every action\'s targetId MUST be exactly "notepad".\n' +
      "Task: Open Notepad\n" +
      "Allowed actions: focus_window, read_screen, click, type_text, key_press, wait, copy_selection, paste.\n" +
      "Verification: worker_ok and screen_capture are always allowed. Use text_match only with expectedText for known on-screen text. Use clipboard only for copy_selection.\n" +
      "Requirements: Safe actions only. Max 12 steps. Every step must have action, requiresApproval, and verification.";
    const previousSystem =
      "You are DesktopPilot's local task planner. Return valid JSON only matching the schema (max 12 steps). Plan safe desktop automation for the target.";
    const previous = estimateTokens(previousSystem) + estimateTokens(previousUser) + schemaOverhead;
    expect(inputTokens("Open Notepad", "notepad")).toBeLessThan(previous);
  });

  it("long histories keep the request and newest lines, not duplicates", () => {
    const ctx = [...Array.from({ length: 8 }, (_, i) => `step ${i} finished`), "step 7 finished"];
    const prompt = buildPlanPrompt({
      userRequest: "Continue typing the report",
      targetId: "word",
      context: ctx,
    });
    expect(prompt).toContain("Continue typing the report");
    expect(prompt.match(/step 7 finished/g)?.length).toBe(1);
    expect(prompt).toContain("step 0 finished");
  });

  it("complex multi-step replan context stays intact when it fits the budget", () => {
    const ctx = [
      "REPLAN: plan ONLY remaining steps from the current screen.",
      "Steps already done: 1. Focus Notepad; 2. Type heading",
      "Current screen: untitled document",
      "Problem after the last step: save dialog appeared",
      "Reuse only approved action kinds, keys, and typed text.",
    ];
    const p = fitLocalPrompt("Save the file as report.txt", "notepad", ctx)!;
    for (const line of ctx) expect(p).toContain(line);
    expect(p).toContain("Save the file as report.txt");
  });

  it("accepts valid plans that omit optional schema fields", () => {
    const parsed = normalizeProviderResponse({
      plan: ["Look", "Type"],
      summary: "Two-step plan",
      steps: [
        {
          action: { kind: "read_screen", targetId: "notepad", description: "Look" },
          requiresApproval: false,
        },
        {
          action: {
            kind: "type_text",
            targetId: "notepad",
            description: "Type",
            text: "hello",
          },
          requiresApproval: true,
          verification: { kind: "text_match", expectedText: "hello" },
        },
      ],
    });
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]?.verification).toBeUndefined();
    expect(parsed.steps[1]?.verification?.expectedText).toBe("hello");
  });

  it("rejects malformed JSON that cannot be repaired", async () => {
    stubLocal(() => sse(["not-json-at-all"]));
    const r = await callLocal(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_response");
    expect(bodies.length).toBe(2);
  });

  it("keeps PLAN_JSON_SCHEMA fields required by execution unchanged", () => {
    expect(PLAN_JSON_SCHEMA.required).toEqual(["plan", "summary", "steps"]);
    expect(PLAN_JSON_SCHEMA.properties.steps.maxItems).toBe(12);
  });
});
