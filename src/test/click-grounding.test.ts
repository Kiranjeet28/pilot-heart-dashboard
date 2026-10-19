import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderResponse } from "@/lib/ai/provider";
import { validateAction } from "@/lib/worker/action-validation";
import { buildPlanPrompt, LOCAL_SYSTEM, PLAN_JSON_SCHEMA } from "@/lib/ai/plan-prompt";
import type { ActionRequest } from "@/lib/types";
import { callLocal, __resetAiStatus, DEFAULT_LOCAL_BASE_URL, configureAiRouting } from "@/lib/ai/aiProvider";
import { DEFAULT_PROVIDERS } from "@/lib/registry/defaults";

const streamPlan = (data: unknown) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(data) } }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } },
);

describe("Qwen click grounding and approved launch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAiStatus();
  });
  const click = (x?: number, y?: number): ActionRequest => ({
    kind: "click",
    targetId: "desktop",
    description: "Click target",
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
  });

  it("rejects missing coordinates without substituting a click location", () => {
    expect(() => normalizeProviderResponse({ steps: [{ action: click(), requiresApproval: false }] }))
      .toThrow(/click requires x and y/);
  });

  it("rejects negative and out-of-screen coordinates and accepts valid grounded bounds", () => {
    const grounded = { screen: { width: 100, height: 80 }, strict: true, visualGroundedObservationId: "shot-1" };
    expect(validateAction(click(-1, 2), grounded).ok).toBe(false);
    expect(validateAction(click(100, 2), grounded).ok).toBe(false);
    expect(validateAction(click(99, 79), grounded).ok).toBe(false);
    expect(validateAction({ ...click(99, 79), observationId: "shot-1" }, grounded).ok).toBe(true);
  });

  it("rejects coordinates when no screenshot was supplied to ground the planner", () => {
    expect(validateAction({ ...click(20, 30), observationId: "invented" }, {
      screen: { width: 100, height: 80 }, strict: true,
    })).toMatchObject({ ok: false, reason: expect.stringContaining("grounded in the latest screenshot") });
  });

  it("does not require click coordinates for other action types", () => {
    const result = normalizeProviderResponse({
      steps: [{ action: { kind: "wait", targetId: "desktop", description: "Pause", durationMs: 1 } }],
    });
    expect(result.steps[0]?.action.kind).toBe("wait");
  });

  it("rejects unsupported fields and invalid waits at the action boundary", () => {
    expect(validateAction({ kind: "wait", targetId: "desktop", description: "Wait", durationMs: 10001 }, { strict: true }).ok).toBe(false);
    expect(validateAction({ kind: "wait", targetId: "desktop", description: "Wait", durationMs: Number.NaN }, { strict: true }).ok).toBe(false);
    expect(validateAction({ kind: "read_screen", targetId: "desktop", description: "Read", x: 1 } as never, { strict: true }).ok).toBe(false);
  });

  it("exposes only approved Notepad launch as a non-coordinate option for open notepad", () => {
    expect(LOCAL_SYSTEM).toContain("launch_app supports only app=notepad");
    expect(PLAN_JSON_SCHEMA.properties.steps.items.properties.action.properties.kind.enum).toContain("launch_app");
    expect(normalizeProviderResponse({
      steps: [{ action: { kind: "launch_app", targetId: "desktop", description: "Open Notepad" } }],
    }).steps[0]?.action).toMatchObject({ kind: "launch_app", app: "notepad" });
  });

  it("tells a text-only planner to stop safely when no screenshot is supplied", () => {
    expect(buildPlanPrompt({ userRequest: "open notepad" })).not.toContain("screenshot");
    expect(LOCAL_SYSTEM).toContain("If no screenshot is supplied, do not click");
    expect(LOCAL_SYSTEM).toContain("return no steps with a clear summary");
  });

  it("plans open notepad with one Qwen request and an approved launch action", async () => {
    __resetAiStatus();
    configureAiRouting(() => ({ mode: "local", localBaseUrl: DEFAULT_LOCAL_BASE_URL }));
    const fetchMock = vi.fn(async () => streamPlan({
      summary: "Notepad is open",
      plan: ["Launch Notepad"],
      steps: [{ action: { kind: "launch_app", targetId: "desktop", description: "Open Notepad" }, requiresApproval: false }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callLocal({ userRequest: "open notepad", provider: DEFAULT_PROVIDERS[0]! });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps[0]?.action.kind).toBe("launch_app");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not make a repeated identical Qwen request to repair missing click coordinates", async () => {
    __resetAiStatus();
    configureAiRouting(() => ({ mode: "local", localBaseUrl: DEFAULT_LOCAL_BASE_URL }));
    const fetchMock = vi.fn(async () => streamPlan({
      summary: "Click",
      plan: ["Click"],
      steps: [{ action: click(), requiresApproval: false }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await callLocal({ userRequest: "click the button", provider: DEFAULT_PROVIDERS[0]! });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
