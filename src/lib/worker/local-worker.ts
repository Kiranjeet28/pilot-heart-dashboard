// REAL LOCAL adapter: authenticated HTTP calls to the Python worker on 127.0.0.1.
import { z } from "zod";
import type { ActionRequest } from "@/lib/types";
import type { ValidatedActionRequest } from "./action-validation";
import type { ActionResult, DesktopWorker, ObservationRequest, ObservationResult, WorkerCapabilities, WorkerHealth, WorkerStatus } from "./worker";

export type WorkerErrorCode = "unreachable" | "not_paired" | "unauthorized" | "forbidden" | "timeout" | "busy" | "stopped" | "cancelled" | "invalid" | "server";

export class WorkerRequestError extends Error {
  constructor(public code: WorkerErrorCode, message: string, public status?: number) {
    super(message);
  }
}

export function diagnose(code: WorkerErrorCode, port: number, detail?: string): string {
  switch (code) {
    case "unreachable":
      return `Could not reach the worker at http://127.0.0.1:${port}. Check that: (1) the worker is running in PowerShell, (2) this site's exact address is in allowed_origins in config.json, (3) you allowed "local network access" if your browser asked. Safari and some privacy settings block secure websites from calling your own computer — see the README's local-development option.`;
    case "not_paired":
      return "Not paired. Enter the pairing code shown in the worker's PowerShell window.";
    case "unauthorized":
      return "The worker rejected the session (expired, rotated key, or wrong code). Restart the worker for a new pairing code and pair again.";
    case "forbidden":
      return `The worker refused this site (${detail ?? "origin not allowed"}). Add this page's origin to allowed_origins in config.json and restart the worker.`;
    case "timeout":
      return "The worker did not respond in time. It may be busy or the desktop may be locked.";
    case "busy":
      return "The worker is already executing an action. Wait and retry.";
    case "stopped":
      return "The worker is stopped (Emergency Stop or mouse fail-safe). Reset the emergency stop to resume.";
    case "cancelled":
      return "The worker rejected the action because the task was cancelled.";
    case "invalid":
      return `The worker rejected the request as invalid${detail ? ` (${detail})` : ""}.`;
    default:
      return `Worker error${detail ? `: ${detail}` : ""}.`;
  }
}

const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  authenticated: z.boolean(),
  busy: z.boolean().optional(),
  stopped: z.boolean().optional(),
  auth_error: z.string().optional(),
  screen: z.object({ width: z.number(), height: z.number() }).nullable().optional(),
});
const PairSchema = z.object({ token: z.string().min(20).max(256), expires_at: z.number() });
const ObserveSchema = z.object({
  observation_id: z.string(),
  width: z.number(),
  height: z.number(),
  captured_at: z.number(),
  image: z.string().startsWith("data:image/"),
});
const ActionSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  completed_at: z.number(),
  clipboard_length: z.number().optional(),
  typed_length: z.number().optional(),
});
const CapsSchema = z.object({ actions: z.array(z.string()), keys: z.array(z.string()), limits: z.record(z.number()), ui_automation: z.boolean() });

export interface LocalWorkerOptions {
  port: () => number;
  getToken: () => string | null;
  fetchImpl?: typeof fetch;
}

type ReqInit = { method?: "GET" | "POST"; body?: unknown; auth?: boolean; timeoutMs?: number };

export class LocalHttpWorker implements DesktopWorker {
  readonly mode = "live" as const;
  constructor(private opts: LocalWorkerOptions) {}

  private async request<T>(path: string, schema: z.ZodType<T>, init: ReqInit = {}): Promise<T> {
    const { method = "GET", body, auth = true, timeoutMs = 8000 } = init;
    const port = this.opts.port();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const t = this.opts.getToken();
      if (!t) throw new WorkerRequestError("not_paired", diagnose("not_paired", port));
      headers["Authorization"] = `Bearer ${t}`; // header only — never in the URL
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      const f = this.opts.fetchImpl ?? fetch;
      res = await f(`http://127.0.0.1:${port}${path}`, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: ctrl.signal,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      if (ctrl.signal.aborted) throw new WorkerRequestError("timeout", diagnose("timeout", port));
      throw new WorkerRequestError("unreachable", diagnose("unreachable", port));
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* empty body */
    }
    if (!res.ok) {
      const detail = typeof (data as { detail?: unknown })?.detail === "string" ? (data as { detail: string }).detail : `HTTP ${res.status}`;
      const code: WorkerErrorCode =
        res.status === 401 ? "unauthorized"
        : res.status === 403 ? "forbidden"
        : res.status === 423 ? "stopped"
        : res.status === 504 ? "timeout"
        : res.status === 409 ? (detail === "busy" ? "busy" : detail === "task_cancelled" ? "cancelled" : "invalid")
        : res.status === 422 || res.status === 400 ? "invalid"
        : "server";
      throw new WorkerRequestError(code, diagnose(code, port, detail), res.status);
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new WorkerRequestError("server", diagnose("server", port, "unexpected response shape"));
    return parsed.data;
  }

  async pair(code: string): Promise<{ token: string; expiresAt: number }> {
    const r = await this.request("/pair", PairSchema, { method: "POST", body: { code }, auth: false });
    return { token: r.token, expiresAt: r.expires_at };
  }

  async getStatus(): Promise<WorkerStatus> {
    if (!this.opts.getToken()) {
      // Probe reachability without credentials so we can give a precise message.
      try {
        const h = await this.request("/health", HealthSchema, { auth: false, timeoutMs: 3000 });
        return { mode: "live", connection: "disconnected", workerVersion: h.version, message: "Worker is running but not paired. Enter the pairing code." };
      } catch (e) {
        return { mode: "live", connection: "disconnected", message: e instanceof Error ? e.message : "Worker unreachable" };
      }
    }
    const h = await this.request("/health", HealthSchema, { timeoutMs: 4000 });
    if (!h.authenticated) return { mode: "live", connection: "error", workerVersion: h.version, message: diagnose("unauthorized", this.opts.port()) };
    return {
      mode: "live",
      connection: h.busy ? "busy" : "connected",
      workerVersion: h.version,
      screen: h.screen ?? undefined,
      stopped: h.stopped ?? false,
      message: h.stopped ? "Connected, but the worker is stopped — reset Emergency Stop to resume." : "Connected to the real local Windows worker.",
    };
  }

  async healthCheck(): Promise<WorkerHealth> {
    const t0 = Date.now();
    try {
      const s = await this.getStatus();
      return { ok: s.connection === "connected" && !s.stopped, latencyMs: Date.now() - t0, checkedAt: Date.now(), message: s.message };
    } catch (e) {
      return { ok: false, latencyMs: 0, checkedAt: Date.now(), message: e instanceof Error ? e.message : "Health check failed" };
    }
  }

  async getCapabilities(): Promise<WorkerCapabilities> {
    const c = await this.request("/capabilities", CapsSchema);
    return { actions: c.actions, keys: c.keys, limits: c.limits, uiAutomation: c.ui_automation };
  }

  async observe(req: ObservationRequest): Promise<ObservationResult> {
    const r = await this.request("/observe", ObserveSchema, { method: "POST", body: { task_id: req.taskId.slice(0, 64) }, timeoutMs: 15000 });
    return { imageDataUrl: r.image, capturedAt: r.captured_at, simulated: false, width: r.width, height: r.height, observationId: r.observation_id };
  }

  async executeAction(taskId: string, action: ValidatedActionRequest): Promise<ActionResult> {
    if (action.kind === "read_screen") {
      const o = await this.observe({ taskId, targetId: action.targetId, targetLabel: action.targetId });
      return { ok: true, message: "Captured real desktop screenshot", simulated: false, completedAt: o.capturedAt };
    }
    const payload = toWorkerPayload(action);
    if (!payload) return { ok: false, message: `${action.kind} is not supported by the local worker yet (UI Automation is a later extension)`, simulated: false, completedAt: Date.now() };
    const r = await this.request("/actions", ActionSchema, {
      method: "POST",
      body: { request_id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, task_id: taskId.slice(0, 64), action: payload },
      timeoutMs: 20000,
    });
    return {
      ok: r.ok,
      message: r.message,
      simulated: false,
      completedAt: r.completed_at,
      data: { ...(r.clipboard_length != null ? { clipboardLength: r.clipboard_length } : {}), ...(r.typed_length != null ? { typedLength: r.typed_length } : {}) },
    };
  }

  async cancelTask(taskId: string): Promise<void> {
    try {
      await this.request("/cancel", z.unknown(), { method: "POST", body: { task_id: taskId.slice(0, 64) }, timeoutMs: 3000 });
    } catch {
      /* best effort — the dashboard runner also refuses to continue */
    }
  }

  async stop(): Promise<void> {
    await this.request("/stop", z.unknown(), { method: "POST", auth: false, timeoutMs: 3000 });
  }

  async resume(): Promise<void> {
    await this.request("/resume", z.unknown(), { method: "POST", timeoutMs: 3000 });
  }
}

export function toWorkerPayload(a: ActionRequest): Record<string, unknown> | null {
  switch (a.kind) {
    case "click":
      return { kind: "click", x: a.x, y: a.y, observation_id: a.observationId };
    case "type_text":
      return { kind: "type_text", text: a.text };
    case "key_press":
      return { kind: "key_press", keys: a.keys?.toLowerCase() };
    case "copy_selection":
      return { kind: "copy_selection" };
    case "paste":
      return a.text ? { kind: "paste", text: a.text } : { kind: "paste" };
    case "wait":
      return { kind: "wait", duration_ms: a.durationMs };
    default:
      return null;
  }
}
