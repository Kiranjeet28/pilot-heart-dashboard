import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_REPLANS,
  MAX_TOTAL_STEPS,
  approvedScopeFrom,
  buildReplanContext,
  canReplan,
  isWithinApprovedScope,
  mergeRemaining,
  parseCheckResult,
  shouldCheckAfter,
} from "@/lib/tasks/adapt";
import { handleStepCheckRequest } from "@/lib/server/step-check";
import { requestStepCheck } from "@/lib/ai/step-check-client";
import type { ActionRequest, PlannedStep } from "@/lib/types";

const step = (
  a: Partial<ActionRequest> & Pick<ActionRequest, "kind">,
  id = Math.random().toString(),
): PlannedStep => ({
  id,
  requiresApproval: false,
  action: { targetId: "notepad", description: a.kind, ...a },
});

const approved = [
  step({ kind: "key_press", keys: "windows+r" }),
  step({ kind: "type_text", text: "notepad" }),
  step({ kind: "key_press", keys: "enter" }),
  step({ kind: "type_text", text: "hello" }),
];
const scope = approvedScopeFrom(approved, "notepad");

const IMG = "data:image/jpeg;base64,QUJD";
const req = (body: unknown, headers: Record<string, string> = { origin: "http://localhost" }) =>
  new Request("http://localhost/api/tasks/check", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const good = {
  taskId: "t1",
  targetId: "notepad",
  taskRequest: "Open Notepad and type hello",
  stepDescription: "Type hello",
  imageDataUrl: IMG,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("approved scope", () => {
  it("allows a replan that reuses approved keys and text", () => {
    expect(
      isWithinApprovedScope(
        [
          step({ kind: "key_press", keys: "Windows+R" }),
          step({ kind: "type_text", text: "notepad" }),
        ],
        scope,
      ).ok,
    ).toBe(true);
  });
  it("always allows wait and read_screen", () => {
    expect(
      isWithinApprovedScope(
        [step({ kind: "wait", durationMs: 500 }), step({ kind: "read_screen" })],
        scope,
      ).ok,
    ).toBe(true);
  });
  it("rejects an unapproved key", () => {
    const r = isWithinApprovedScope([step({ kind: "key_press", keys: "alt+f4" })], scope);
    expect(r.ok).toBe(false);
  });
  it("rejects an unapproved action kind", () => {
    expect(isWithinApprovedScope([step({ kind: "paste" })], scope).ok).toBe(false);
  });
  it("rejects text the user didn't approve", () => {
    expect(isWithinApprovedScope([step({ kind: "type_text", text: "rm -rf" })], scope).ok).toBe(
      false,
    );
  });
  it("rejects a different target", () => {
    expect(isWithinApprovedScope([step({ kind: "wait", targetId: "vscode" })], scope).ok).toBe(
      false,
    );
  });
});

describe("replan limits and merge", () => {
  it("allows at most 3 replans", () => {
    expect(MAX_REPLANS).toBe(3);
    expect(canReplan(2)).toBe(true);
    expect(canReplan(3)).toBe(false);
  });
  it("keeps done steps and replaces the rest", () => {
    const r = mergeRemaining(approved, 1, [step({ kind: "wait" }, "new")]);
    expect(r.ok && r.steps.map((s) => s.id)).toEqual([approved[0]!.id, approved[1]!.id, "new"]);
    expect(r.ok && r.steps[1]!.done).toBe(true);
  });
  it("refuses a plan longer than 20 steps", () => {
    expect(MAX_TOTAL_STEPS).toBe(20);
    const many = Array.from({ length: 19 }, () => step({ kind: "wait" }));
    expect(mergeRemaining(approved, 1, many).ok).toBe(false);
  });
  it("builds context within the plan route limits", () => {
    const ctx = buildReplanContext(approved, 1, {
      verdict: "off_track",
      reason: "x".repeat(900),
      screenSummary: "",
    });
    expect(ctx.length).toBeLessThanOrEqual(12);
    expect(ctx.every((c) => c.length <= 500)).toBe(true);
  });
  it("only checks after screen-changing actions", () => {
    expect(shouldCheckAfter("launch_app")).toBe(true);
    expect(shouldCheckAfter("click")).toBe(true);
    expect(shouldCheckAfter("read_screen")).toBe(false);
    expect(shouldCheckAfter("wait")).toBe(false);
  });
});

describe("check answers", () => {
  it("parses a valid verdict", () => {
    expect(
      parseCheckResult({ verdict: "off_track", reason: "No Notepad", screenSummary: "Desktop" })
        ?.verdict,
    ).toBe("off_track");
  });
  it("rejects an unknown verdict", () => {
    expect(parseCheckResult({ verdict: "pass", reason: "x" })).toBeNull();
  });
});

describe("/api/tasks/check", () => {
  it("rejects requests without same-origin evidence", async () => {
    expect((await handleStepCheckRequest(req(good, {}))).status).toBe(401);
  });
  it("rejects a non-image payload", async () => {
    expect(
      (await handleStepCheckRequest(req({ ...good, imageDataUrl: "javascript:alert(1)" }))).status,
    ).toBe(400);
  });
  it("rejects invalid JSON", async () => {
    expect((await handleStepCheckRequest(req("{nope"))).status).toBe(400);
  });
  it("rejects an oversized screenshot", async () => {
    const big = { ...good, imageDataUrl: "data:image/jpeg;base64," + "A".repeat(1_600_000) };
    expect((await handleStepCheckRequest(req(big))).status).toBe(413);
  });
  it("returns the model verdict", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "ok",
                  reason: "Text visible",
                  screenSummary: "Notepad",
                }),
              },
            },
          ],
        }),
      ),
    );
    const res = await handleStepCheckRequest(req(good));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verdict: string }).verdict).toBe("ok");
  });
  it("sends the Gemini key in a header, never in the request URL", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-secret");
    vi.stubEnv("GEMINI_MODEL", "gemini-3.8-flash");
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      );
      expect(String(url)).not.toContain("test-gemini-secret");
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-gemini-secret");
      return Response.json({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ verdict: "ok", reason: "Visible", screenSummary: "Desktop" }) }] } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await handleStepCheckRequest(req(good));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects a malformed model answer", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ choices: [{ message: { content: '{"verdict":"maybe"}' } }] }),
      ),
    );
    expect((await handleStepCheckRequest(req(good))).status).toBe(502);
  });
  it("reports a timeout as 504", async () => {
    vi.useFakeTimers();
    vi.stubEnv("LOVABLE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise((_r, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      ),
    );
    const p = handleStepCheckRequest(req(good));
    await vi.advanceTimersByTimeAsync(16_000);
    expect((await p).status).toBe(504);
    vi.useRealTimers();
  });
});

describe("browser check client", () => {
  it("turns a server error into unsure, never ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "down" }, { status: 502 })),
    );
    const r = await requestStepCheck(good);
    expect(r.verdict).toBe("unsure");
  });
  it("turns a network failure into unsure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect((await requestStepCheck(good)).verdict).toBe("unsure");
  });
});

import { parseRetryAfterSeconds } from "@/lib/tasks/adapt";
describe("AI quota handling", () => {
  it("reads Google's retry hint", () => {
    expect(parseRetryAfterSeconds("Please retry in 58.036322721s.")).toBe(59);
  });
  it("caps the wait at 65 seconds", () => {
    expect(parseRetryAfterSeconds("retry in 300s")).toBe(65);
  });
  it("marks a 429 check as rate limited and unsure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "quota" }, { status: 429 })),
    );
    const r = await requestStepCheck(good);
    expect(r.verdict).toBe("unsure");
    expect(r.rateLimited).toBe(true);
  });
});
