import { describe, expect, it, vi } from "vitest";
import { LocalHttpWorker, WorkerRequestError, toWorkerPayload } from "@/lib/worker/local-worker";
import { validateAction } from "@/lib/worker/action-validation";
import { checkReadiness } from "@/lib/safety/readiness";
import { DEFAULT_PROFILES, DEFAULT_PROVIDERS, DEFAULT_TARGETS } from "@/lib/registry/defaults";

const TOKEN = "v1.9999999999.abcdefghijklmnop.signature-value";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function make(fetchImpl: typeof fetch, token: string | null = TOKEN) {
  return new LocalHttpWorker({ port: () => 8765, getToken: () => token, fetchImpl });
}

describe("LocalHttpWorker", () => {
  it("reports Connected only after an authenticated health check", async () => {
    const f = vi.fn(async () =>
      json({
        ok: true,
        version: "0.2.0",
        authenticated: true,
        busy: false,
        stopped: false,
        screen: { width: 1920, height: 1080 },
      }),
    );
    const s = await make(f as unknown as typeof fetch).getStatus();
    expect(s.connection).toBe("connected");
    expect(s.mode).toBe("live");
  });

  it("is not connected when the worker does not accept the token", async () => {
    const f = vi.fn(async () =>
      json({
        ok: true,
        version: "0.2.0",
        authenticated: false,
        auth_error: "invalid_or_expired_token",
      }),
    );
    expect((await make(f as unknown as typeof fetch).getStatus()).connection).toBe("error");
  });

  it("is disconnected when not paired, even if the worker is running", async () => {
    const f = vi.fn(async () => json({ ok: true, version: "0.2.0", authenticated: false }));
    expect((await make(f as unknown as typeof fetch, null).getStatus()).connection).toBe(
      "disconnected",
    );
  });

  it("sends the token only in the Authorization header, never the URL", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) =>
      json({ ok: true, version: "0.2.0", authenticated: true }),
    );
    await make(f as unknown as typeof fetch).getStatus();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8765/health");
    expect(url).not.toContain(TOKEN);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a network failure to an 'unreachable' diagnostic", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      make(f as unknown as typeof fetch).observe({ taskId: "t", targetId: "x", targetLabel: "x" }),
    ).rejects.toMatchObject({ code: "unreachable" });
  });

  it("maps 401 to unauthorized and 423 to stopped", async () => {
    const w401 = make((async () =>
      json({ detail: "unauthorized" }, 401)) as unknown as typeof fetch);
    await expect(
      w401.observe({ taskId: "t", targetId: "x", targetLabel: "x" }),
    ).rejects.toBeInstanceOf(WorkerRequestError);
    await expect(
      w401.observe({ taskId: "t", targetId: "x", targetLabel: "x" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const w423 = make((async () =>
      json({ detail: "worker_stopped" }, 423)) as unknown as typeof fetch);
    await expect(
      w423.observe({ taskId: "t", targetId: "x", targetLabel: "x" }),
    ).rejects.toMatchObject({ code: "stopped" });
  });

  it("marks real results as not simulated", async () => {
    const f = vi.fn(async () => json({ ok: true, message: "Pressed enter", completed_at: 1 }));
    const v = validateAction(
      { kind: "key_press", targetId: "n", keys: "enter", description: "x" },
      { strict: true },
    );
    if (!v.ok) throw new Error(v.reason);
    expect((await make(f as unknown as typeof fetch).executeAction("t", v.action)).simulated).toBe(
      false,
    );
  });

  it("stop works without a session token", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => json({ stopped: true }));
    await make(f as unknown as typeof fetch, null).stop();
    expect(f.mock.calls[0]![0]).toBe("http://127.0.0.1:8765/stop");
  });
});

describe("strict (real worker) validation", () => {
  const base = { targetId: "n", description: "x" };
  it("rejects keys outside the allowlist", () => {
    expect(
      validateAction({ ...base, kind: "key_press", keys: "alt+f4" }, { strict: true }).ok,
    ).toBe(false);
    expect(
      validateAction({ ...base, kind: "key_press", keys: "ctrl+a" }, { strict: true }).ok,
    ).toBe(true);
    expect(
      validateAction({ ...base, kind: "key_press", keys: "ctrl+," }, { strict: true }).ok,
    ).toBe(true);
  });
  it("rejects clicks outside the observed screen", () => {
    expect(
      validateAction(
        { ...base, kind: "click", x: 1920, y: 10, observationId: "o" },
        { strict: true, screen: { width: 1920, height: 1080 } },
      ).ok,
    ).toBe(false);
  });
  it("requires an observation for real clicks", () => {
    expect(validateAction({ ...base, kind: "click", x: 5, y: 5 }, { strict: true }).ok).toBe(false);
  });
  it("rejects non-ASCII / control characters in real typing", () => {
    expect(
      validateAction({ ...base, kind: "type_text", text: "hi\u0007" }, { strict: true }).ok,
    ).toBe(false);
  });
  it("maps paste without text to a clipboard paste", () => {
    expect(toWorkerPayload({ ...base, kind: "paste" })).toEqual({ kind: "paste" });
  });
});

describe("readiness in REAL LOCAL mode", () => {
  const base = {
    providerId: "qwen",
    profileId: "personal",
    targetId: "vscode",
    providers: DEFAULT_PROVIDERS,
    profiles: DEFAULT_PROFILES,
    targets: DEFAULT_TARGETS,
    tasks: [],
    emergencyStop: false,
    worker: "connected" as const,
  };
  it("blocks tasks when the real worker is not connected", () => {
    expect(
      checkReadiness({ ...base, realWorker: { connected: false, message: "Not paired" } }).some(
        (i) => i.includes("Not paired"),
      ),
    ).toBe(true);
  });
  it("allows tasks when the real worker is connected", () => {
    expect(checkReadiness({ ...base, realWorker: { connected: true, message: "ok" } })).toEqual([]);
  });
});
