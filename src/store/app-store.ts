// Central app store + demo task runner. UI reads via useAppState; mutations go through `actions`.
import { useSyncExternalStore } from "react";
import type {
  AccountProfile,
  ActionRequest,
  ActivityEvent,
  ActivityKind,
  AppSettings,
  DesktopTarget,
  Provider,
  Task,
  TaskStatus,
  WorkerSelection,
} from "@/lib/types";
import {
  DEFAULT_PROFILES,
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  DEFAULT_TARGETS,
} from "@/lib/registry/defaults";
import { canTransition, isActive } from "@/lib/tasks/state-machine";
import { normalizeProviderPlan } from "@/lib/tasks/planner";
import { createAIProvider, MockAIProvider } from "@/lib/ai/provider";
import { verifyActionOutcome } from "@/lib/tasks/verification";
import { validateAction } from "@/lib/worker/action-validation";
import { MockDesktopWorker } from "@/lib/worker/mock-worker";
import type { ActionResult, DesktopWorker, ObservationResult } from "@/lib/worker/worker";
import { LocalHttpWorker } from "@/lib/worker/local-worker";
import { clearSession, readSession, writeSession } from "@/lib/worker/token-store";
import { WorkerUnavailableError } from "@/lib/worker/worker";
import { clearAll, load, save } from "@/lib/persistence/local-store";
import { checkReadiness } from "@/lib/safety/readiness";

export interface AppState {
  hydrated: boolean;
  providers: Provider[];
  profiles: AccountProfile[];
  targets: DesktopTarget[];
  tasks: Task[]; // newest first
  activity: ActivityEvent[]; // newest first, includes global events
  settings: AppSettings;
  emergencyStop: boolean;
  /** Live connection state of the selected worker. Not persisted. */
  connection: WorkerConnectionInfo;
  /** User confirmed real desktop actions for this session. Not persisted. */
  realActionsConfirmed: boolean;
}

export type ConnectionState = "disconnected" | "pairing" | "connected" | "busy" | "error";
export interface WorkerConnectionInfo {
  state: ConnectionState;
  message: string;
  version?: string | undefined;
  screen?: { width: number; height: number } | undefined;
  stopped?: boolean | undefined;
  checkedAt?: number | undefined;
}

const initial: AppState = {
  hydrated: false,
  providers: DEFAULT_PROVIDERS,
  profiles: DEFAULT_PROFILES,
  targets: DEFAULT_TARGETS,
  tasks: [],
  activity: [],
  settings: DEFAULT_SETTINGS,
  emergencyStop: false,
  connection: { state: "connected", message: "Demo worker (simulated)" },
  realActionsConfirmed: false,
};

let state = initial;
const listeners = new Set<() => void>();
const MAX_ACTIVITY = 500;

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if (state.hydrated) persist(p);
  listeners.forEach((l) => l());
}

function persist(p: Partial<AppState>) {
  if (p.providers || p.profiles || p.targets)
    save("config", {
      providers: state.providers,
      profiles: state.profiles,
      targets: state.targets,
    });
  // Real screenshots are never written to storage — only simulated previews persist.
  if (p.tasks)
    save(
      "tasks",
      state.tasks.map((t) =>
        t.lastObservation && !t.lastObservation.simulated
          ? { ...t, lastObservation: undefined }
          : t,
      ),
    );
  if (p.activity) save("activity", state.activity);
  if (p.settings || "emergencyStop" in p)
    save("settings", { ...state.settings, emergencyStop: state.emergencyStop });
}

export const store = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(state),
    () => selector(initial),
  );
}

// ---------- worker ----------
const mockWorker = new MockDesktopWorker({
  isConnected: () => state.settings.workerSimulation === "connected",
  failureRate: () => state.settings.failureRate,
});
export const localWorker = new LocalHttpWorker({
  port: () => state.settings.workerPort,
  getToken: () => readSession()?.token ?? null,
});
const isReal = () => state.settings.workerMode === "real_local";
export const currentWorker = (): DesktopWorker => (isReal() ? localWorker : mockWorker);

/** Stable facade that always delegates to the selected worker. */
export const worker: DesktopWorker = {
  get mode() {
    return currentWorker().mode;
  },
  getStatus: () => currentWorker().getStatus(),
  healthCheck: () => currentWorker().healthCheck(),
  observe: (r) => currentWorker().observe(r),
  executeAction: (t, a) => currentWorker().executeAction(t, a),
  cancelTask: (t) => currentWorker().cancelTask(t),
};

// ---------- helpers ----------
let counter = 0;
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

function log(
  taskId: string | null,
  kind: ActivityKind,
  message: string,
  simulated = true,
  real = false,
) {
  const ev: ActivityEvent = {
    id: uid("ev"),
    taskId,
    timestamp: Date.now(),
    kind,
    message,
    simulated,
    ...(real ? { real: true } : {}),
  };
  set((s) => ({ activity: [ev, ...s.activity].slice(0, MAX_ACTIVITY) }));
}

const getTask = (id: string) => state.tasks.find((t) => t.id === id);

function patchTask(id: string, patch: Partial<Task>) {
  set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
}

function transition(id: string, to: TaskStatus, extra: Partial<Task> = {}): boolean {
  const t = getTask(id);
  if (!t || !canTransition(t.status, to)) return false;
  const terminal = to === "completed" || to === "failed" || to === "cancelled";
  patchTask(id, { status: to, ...(terminal ? { endedAt: Date.now() } : {}), ...extra });
  return true;
}

// ---------- runner ----------
const timers = new Map<string, ReturnType<typeof setTimeout>>();
function clearTimer(id: string) {
  const h = timers.get(id);
  if (h) clearTimeout(h);
  timers.delete(id);
}
function schedule(id: string, ms = state.settings.stepDelayMs) {
  clearTimer(id);
  timers.set(
    id,
    setTimeout(() => void tick(id), ms),
  );
}

function fail(id: string, error: string) {
  const sim = currentWorker().mode === "demo";
  if (transition(id, "failed", { error, summary: `Failed: ${error}` }))
    log(id, "error", error, sim, !sim);
}

async function tick(id: string) {
  timers.delete(id);
  const t = getTask(id);
  if (!t || state.emergencyStop) return;
  const w = currentWorker();
  const sim = w.mode === "demo";
  const tag = sim ? "[SIMULATED]" : "[REAL]";
  try {
    if (t.deadlineAt && Date.now() >= t.deadlineAt) return fail(id, "Task execution timed out");
    if (t.status === "queued") {
      const h = await w.healthCheck();
      if (getTask(id)?.status !== "queued") return;
      if (!h.ok)
        return fail(
          id,
          sim
            ? "Worker disconnected — health check failed"
            : `Real worker unavailable: ${h.message}`,
        );
      log(
        id,
        "info",
        `Worker health OK (${h.latencyMs} ms, ${sim ? "demo" : "real local worker"})`,
        sim,
      );
      transition(id, "planning");
      log(
        id,
        "info",
        sim
          ? "Planning steps (demo planner — no AI provider call)"
          : "Planning observation-only steps (real mode, no AI provider call)",
        sim,
      );
      return schedule(id);
    }
    if (t.status === "planning") {
      const target = state.targets.find((x) => x.id === t.targetId);
      if (!target) return fail(id, "Desktop target no longer exists");
      const provider = state.providers.find((x) => x.id === t.providerId);
      const profile = state.profiles.find((x) => x.id === t.profileId);
      if (!provider || !profile) return fail(id, "Task provider or profile no longer exists");
      log(id, "info", sim ? "Planning with mock provider" : "Planning with Gemini");
      const planned = sim
        ? await new MockAIProvider().getNextStep({
            taskId: id,
            userRequest: t.description,
            targetId: t.targetId,
            provider,
            profile,
          })
        : await createAIProvider(provider, profile).getNextStep({
            taskId: id,
            userRequest: t.description,
            targetId: t.targetId,
            provider,
            profile,
            context: t.lastVerifiedResult ? [t.lastVerifiedResult] : [],
          });
      if (getTask(id)?.status !== "planning" || state.emergencyStop) return;
      if (!planned.ok)
        return fail(id, `${provider.displayName} planning failed: ${planned.message}`);
      const capabilities = !sim && w.getCapabilities ? await w.getCapabilities() : undefined;
      const steps = normalizeProviderPlan(planned, target, capabilities?.actions);
      if (capabilities?.keys) {
        const helperKeys = new Set(capabilities.keys.map((k) => k.toLowerCase()));
        const missing = steps
          .filter((s) => s.action.kind === "key_press" && s.action.keys)
          .map((s) => s.action.keys!.toLowerCase())
          .filter((k) => !helperKeys.has(k));
        if (missing.length)
          return fail(
            id,
            `The helper on your PC is an older version and does not allow: ${[...new Set(missing)].join(", ")}. In PowerShell: stop the helper (Ctrl+C), run "git pull", then ".\\start-worker.ps1" and pair again.`,
          );
      }
      transition(id, "running", { steps, currentStep: 0 });
      log(id, "info", `Plan ready: ${steps.length} ${sim ? "simulated" : "Gemini"} steps`, sim);
      return schedule(id);
    }
    if (t.status !== "running") return;

    const step = t.steps[t.currentStep];
    if (!step) {
      const tname = state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId;
      transition(id, "completed", {
        progress: 100,
        summary: sim
          ? `Completed ${t.steps.length} simulated steps on ${tname}. No real desktop actions were performed.`
          : `Completed ${t.steps.length} real observation steps via the local worker. No input was sent to the desktop.`,
      });
      log(
        id,
        "result",
        sim ? "Task completed (demo)" : "Task completed (real local worker)",
        sim,
        !sim,
      );
      return;
    }
    if (!sim && !state.realActionsConfirmed) {
      transition(id, "waiting_for_approval");
      log(
        id,
        "approval",
        "Confirmation required before the first REAL desktop action this session",
        false,
      );
      return;
    }
    if (step.requiresApproval && !step.approved) {
      transition(id, "waiting_for_approval");
      log(id, "approval", `Approval required: ${step.action.description}`);
      return;
    }
    let action = step.action;
    if (!sim && action.kind === "click" && !action.observationId) {
      const before = await w.observe({
        taskId: id,
        targetId: t.targetId,
        targetLabel: state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId,
        note: "Fresh observation before coordinate action",
      });
      if (getTask(id)?.status !== "running" || state.emergencyStop) return;
      action = before.observationId ? { ...action, observationId: before.observationId } : action;
      patchTask(id, {
        steps: getTask(id)!.steps.map((s, i) => (i === t.currentStep ? { ...s, action } : s)),
      });
    }
    const v = validateAction(action, { strict: !sim, screen: state.connection.screen });
    if (!v.ok) return fail(id, `Action rejected by validator: ${v.reason}`);
    patchTask(id, { currentAction: action, verification: { status: "pending" } });
    log(id, "action", `${tag} ${action.description}`, sim, !sim);
    let realObs: ObservationResult | undefined;
    let result: ActionResult;
    if (!sim && action.kind === "read_screen") {
      realObs = await w.observe({ taskId: id, targetId: t.targetId, targetLabel: t.targetId });
      result = {
        ok: true,
        message: "Captured real desktop screenshot",
        simulated: false,
        completedAt: realObs.capturedAt,
      };
    } else {
      result = await w.executeAction(id, v.action);
    }
    if (getTask(id)?.status !== "running") return; // paused/cancelled meanwhile
    if (!result.ok) {
      const cur = getTask(id)!;
      if (cur.retries < 2) {
        patchTask(id, { retries: cur.retries + 1 });
        log(id, "warning", `${result.message}. Retrying (${cur.retries + 1}/2)…`);
        return schedule(id);
      }
      return fail(id, `${result.message} after 2 retries`);
    }
    const obs =
      sim || !realObs
        ? await w.observe({
            taskId: id,
            targetId: t.targetId,
            targetLabel: state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId,
            note: action.description,
          })
        : realObs;
    if (getTask(id)?.status !== "running") return;
    transition(id, "verifying");
    const verification = verifyActionOutcome(
      action,
      {
        ok: result.ok,
        message: result.message,
        result: obs?.imageDataUrl,
        ...(result.text ? { text: result.text } : {}),
        ...(result.data ? { data: result.data } : {}),
      },
      step.verification,
    );
    if (getTask(id)?.status !== "verifying") return;
    if (verification.status === "failed") {
      patchTask(id, {
        verification: {
          status: verification.status,
          reason: verification.reason,
          checkedAt: Date.now(),
        },
      });
      const cur = getTask(id)!;
      if (cur.retries < 2) {
        patchTask(id, { retries: cur.retries + 1 });
        transition(id, "running");
        log(id, "warning", `${verification.reason} Retrying (${cur.retries}/2)…`, sim);
        return schedule(id);
      }
      return fail(id, `${verification.reason} after 2 verification retries`);
    }
    if (verification.status === "unverified") {
      patchTask(id, {
        verification: {
          status: "unverified",
          reason: verification.reason,
          checkedAt: Date.now(),
        },
      });
      log(
        id,
        "warning",
        `${verification.reason} Recorded as unverified — continuing without retry.`,
        sim,
      );
    }
    const next = t.currentStep + 1;
    transition(id, "running");
    patchTask(id, {
      currentStep: next,
      retries: 0,
      progress: Math.round((next / t.steps.length) * 100),
      steps: getTask(id)!.steps.map((s, i) => (i === t.currentStep ? { ...s, done: true } : s)),
      ...(obs
        ? {
            lastObservation: {
              imageDataUrl: obs.imageDataUrl,
              capturedAt: obs.capturedAt,
              simulated: obs.simulated,
              ...(obs.width ? { width: obs.width, height: obs.height } : {}),
            },
          }
        : {}),
      verification: {
        status: verification.status,
        reason: verification.reason,
        checkedAt: Date.now(),
      },
      lastVerifiedResult: verification.evidence ?? verification.reason,
      currentAction: undefined,
    });
    log(id, "result", `${sim ? "" : "[REAL] "}${result.message}`, sim, !sim);
    schedule(id);
  } catch (e) {
    if (e instanceof WorkerUnavailableError) fail(id, e.message);
    else fail(id, e instanceof Error ? e.message : "Unknown error");
  }
}

// ---------- actions ----------
export interface NewTaskInput {
  description: string;
  providerId: string;
  profileId: string;
  targetId: string;
}

export const actions = {
  hydrate() {
    if (state.hydrated) return;
    const config = load<Pick<AppState, "providers" | "profiles" | "targets">>("config");
    const tasks = load<Task[]>("tasks") ?? [];
    const activity = load<ActivityEvent[]>("activity") ?? [];
    const settings = load<AppSettings & { emergencyStop?: boolean }>("settings");
    // In-flight tasks cannot survive reload — pause them.
    const restored = tasks.map((t) =>
      ["queued", "planning", "running"].includes(t.status)
        ? { ...t, status: "paused" as const }
        : t,
    );
    state = {
      ...state,
      ...(config ?? {}),
      tasks: restored,
      activity,
      settings: settings
        ? {
            ...DEFAULT_SETTINGS,
            workerSimulation: settings.workerSimulation,
            failureRate: settings.failureRate,
            stepDelayMs: settings.stepDelayMs,
            workerMode: settings.workerMode ?? "demo",
            workerPort: settings.workerPort ?? DEFAULT_SETTINGS.workerPort,
          }
        : DEFAULT_SETTINGS,
      emergencyStop: settings?.emergencyStop ?? false,
      hydrated: true,
    };
    listeners.forEach((l) => l());
    if (restored.some((t, i) => t.status !== tasks[i]?.status))
      log(null, "warning", "Dashboard reloaded — in-flight tasks were paused");
  },

  readiness(i: Omit<NewTaskInput, "description">) {
    return checkReadiness({
      ...i,
      ...state,
      worker: state.settings.workerSimulation,
      realWorker: isReal()
        ? {
            connected: state.connection.state === "connected" && !state.connection.stopped,
            message: state.connection.message,
          }
        : undefined,
    });
  },

  createTask(
    input: NewTaskInput,
    start: boolean,
  ): { ok: true; id: string } | { ok: false; issues: string[] } {
    if (!input.description.trim()) return { ok: false, issues: ["Describe the task."] };
    if (input.description.length > 4000)
      return { ok: false, issues: ["Task description is too long (max 4000)."] };
    if (start) {
      const issues = actions.readiness(input);
      if (issues.length) return { ok: false, issues };
    }
    const task: Task = {
      id: uid("task"),
      ...input,
      description: input.description.trim(),
      status: "draft",
      createdAt: Date.now(),
      progress: 0,
      steps: [],
      currentStep: 0,
      retries: 0,
      replans: 0,
      deadlineAt: Date.now() + 10 * 60 * 1000,
    };
    set((s) => ({ tasks: [task, ...s.tasks] }));
    log(task.id, "info", start ? "Task created" : "Draft saved", false);
    if (start) actions.start(task.id);
    return { ok: true, id: task.id };
  },

  start(id: string): string[] {
    const t = getTask(id);
    if (!t) return ["Task not found"];
    const issues = actions
      .readiness(t)
      .filter(
        (x) =>
          !x.startsWith("Another task") ||
          state.tasks.some((o) => o.id !== id && isActive(o.status)),
      );
    if (issues.length) return issues;
    if (!transition(id, "queued", { startedAt: Date.now() }))
      return ["Task cannot be started from its current state"];
    log(id, "info", "Queued");
    schedule(id, 300);
    return [];
  },

  pause(id: string) {
    const t = getTask(id);
    if (!t || !transition(id, "paused")) return;
    clearTimer(id);
    log(id, "info", "Paused by user", false);
  },

  resume(id: string): string[] {
    const t = getTask(id);
    if (!t || t.status !== "paused") return [];
    if (state.emergencyStop) return ["Emergency stop is engaged"];
    if (!isReal() && state.settings.workerSimulation === "disconnected")
      return ["Worker is disconnected"];
    if (isReal() && state.connection.state !== "connected")
      return [`Real worker not connected: ${state.connection.message}`];
    transition(id, t.steps.length ? "running" : "queued");
    log(id, "info", "Resumed by user", false);
    schedule(id, 300);
    return [];
  },

  cancel(id: string, reason = "Cancelled by user") {
    if (!transition(id, "cancelled", { summary: reason })) return;
    clearTimer(id);
    void currentWorker().cancelTask(id);
    log(id, "warning", reason, false);
  },

  approve(id: string) {
    const t = getTask(id);
    if (!t || t.status !== "waiting_for_approval") return;
    if (isReal()) set({ realActionsConfirmed: true });
    patchTask(id, {
      steps: t.steps.map((s, i) => (i === t.currentStep ? { ...s, approved: true } : s)),
    });
    transition(id, "running");
    log(id, "approval", "Step approved by user", false);
    schedule(id, 300);
  },

  reject(id: string) {
    actions.cancel(id, "Step rejected by user — task cancelled");
  },

  retry(id: string) {
    const t = getTask(id);
    if (!t) return { ok: false as const, issues: ["Task not found"] };
    return actions.createTask(
      {
        description: t.description,
        providerId: t.providerId,
        profileId: t.profileId,
        targetId: t.targetId,
      },
      true,
    );
  },

  deleteTask(id: string) {
    const t = getTask(id);
    if (!t || isActive(t.status)) return;
    set((s) => ({
      tasks: s.tasks.filter((x) => x.id !== id),
      activity: s.activity.filter((a) => a.taskId !== id),
    }));
  },

  emergencyStop() {
    timers.forEach((h) => clearTimeout(h));
    timers.clear();
    set({ emergencyStop: true });
    // Always tell the real worker to stop too (no token needed), even in DEMO mode in case it's running.
    void localWorker.stop().then(
      () => log(null, "safety", "Local worker acknowledged STOP", false),
      () =>
        isReal() &&
        log(
          null,
          "warning",
          "Could not reach the local worker to send STOP — use Ctrl+C in its PowerShell window",
          false,
        ),
    );
    state.tasks
      .filter((t) => isActive(t.status))
      .forEach((t) => actions.cancel(t.id, "Cancelled by EMERGENCY STOP"));
    log(null, "safety", "EMERGENCY STOP engaged — all tasks halted, new tasks blocked", false);
  },

  resetEmergencyStop() {
    set({ emergencyStop: false });
    if (isReal() && readSession())
      void localWorker
        .resume()
        .catch(() => undefined)
        .then(() => actions.refreshConnection());
    log(null, "safety", "Emergency stop reset", false);
  },

  updateSettings(p: Partial<AppSettings>) {
    set((s) => ({ settings: { ...s.settings, ...p } }));
    if (p.workerSimulation)
      log(
        null,
        p.workerSimulation === "connected" ? "info" : "warning",
        `Mock worker ${p.workerSimulation} (simulated)`,
      );
  },

  upsertProvider(p: Provider, originalId?: string) {
    set((s) => ({ providers: upsert(s.providers, p, originalId) }));
  },
  deleteProvider(id: string) {
    set((s) => ({ providers: s.providers.filter((p) => p.id !== id) }));
  },
  upsertProfile(p: AccountProfile, originalId?: string) {
    set((s) => ({ profiles: upsert(s.profiles, p, originalId) }));
  },
  deleteProfile(id: string) {
    set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) }));
  },
  upsertTarget(t: DesktopTarget, originalId?: string) {
    set((s) => ({ targets: upsert(s.targets, t, originalId) }));
  },
  deleteTarget(id: string) {
    set((s) => ({ targets: s.targets.filter((t) => t.id !== id) }));
  },

  async refreshConnection() {
    if (!isReal()) {
      const c = state.settings.workerSimulation === "connected";
      set({
        connection: {
          state: c ? "connected" : "disconnected",
          message: c ? "Demo worker (simulated)" : "Demo worker disconnected (simulated)",
          checkedAt: Date.now(),
        },
      });
      return;
    }
    if (state.connection.state === "pairing") return;
    try {
      const s = await localWorker.getStatus();
      if (!isReal()) return;
      set({
        connection: {
          state: s.connection === "pairing" ? "pairing" : s.connection,
          message: s.message,
          version: s.workerVersion,
          screen: s.screen,
          stopped: s.stopped,
          checkedAt: Date.now(),
        },
      });
    } catch (e) {
      if (!isReal()) return;
      set({
        connection: {
          state: "error",
          message: e instanceof Error ? e.message : "Worker error",
          checkedAt: Date.now(),
        },
      });
    }
  },

  async pairWorker(code: string): Promise<string | null> {
    const c = code.trim();
    if (!/^[A-Za-z0-9-]{8,9}$/.test(c))
      return "Enter the 8-character code shown in the worker window (e.g. ABCD-EFGH).";
    set({ connection: { state: "pairing", message: "Pairing with local worker…" } });
    try {
      const r = await localWorker.pair(c);
      writeSession({ token: r.token, expiresAt: r.expiresAt });
      set({ connection: { state: "disconnected", message: "Paired — verifying…" } });
      log(null, "info", "Paired with local Windows worker", false);
      await actions.refreshConnection();
      return null;
    } catch (e) {
      set({
        connection: { state: "error", message: e instanceof Error ? e.message : "Pairing failed" },
      });
      return e instanceof Error ? e.message : "Pairing failed";
    }
  },

  unpairWorker() {
    clearSession();
    set({ realActionsConfirmed: false });
    log(null, "info", "Unpaired from local worker", false);
    void actions.refreshConnection();
  },

  setWorkerMode(mode: WorkerSelection): string | null {
    if (state.tasks.some((t) => isActive(t.status)))
      return "Finish or cancel the active task before switching worker mode.";
    set((s) => ({ settings: { ...s.settings, workerMode: mode }, realActionsConfirmed: false }));
    log(
      null,
      "info",
      mode === "demo" ? "Switched to DEMO mode (simulated worker)" : "Switched to REAL LOCAL mode",
      false,
    );
    void actions.refreshConnection();
    return null;
  },

  setWorkerPort(port: number): string | null {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return "Port must be 1024–65535";
    set((s) => ({ settings: { ...s.settings, workerPort: port } }));
    void actions.refreshConnection();
    return null;
  },

  confirmRealActions() {
    set({ realActionsConfirmed: true });
    log(null, "safety", "User confirmed real desktop actions for this session", false);
  },

  /** Guarded single real action (used by the guided Notepad test). */
  async runRealAction(
    a: ActionRequest,
    screen?: { width: number; height: number },
  ): Promise<ActionResult> {
    if (!isReal()) throw new Error("Switch to REAL LOCAL mode first.");
    if (state.emergencyStop) throw new Error("Emergency stop is engaged.");
    if (!state.realActionsConfirmed) throw new Error("Confirm real desktop actions first.");
    const v = validateAction(a, { strict: true, screen });
    if (!v.ok) {
      log(null, "error", `Rejected: ${v.reason}`, false);
      throw new Error(v.reason);
    }
    log(null, "action", `[REAL] ${a.description}`, false, true);
    try {
      const r = await localWorker.executeAction("guided-notepad-test", v.action);
      log(null, r.ok ? "result" : "error", `[REAL] ${r.message}`, false, true);
      return r;
    } catch (e) {
      log(null, "error", `[REAL] ${e instanceof Error ? e.message : "Action failed"}`, false, true);
      throw e;
    }
  },

  async realObserve(): Promise<ObservationResult> {
    if (!isReal()) throw new Error("Switch to REAL LOCAL mode first.");
    if (state.emergencyStop) throw new Error("Emergency stop is engaged.");
    if (!state.realActionsConfirmed) throw new Error("Confirm real desktop actions first.");
    const o = await localWorker.observe({
      taskId: "guided-notepad-test",
      targetId: "desktop",
      targetLabel: "Desktop",
    });
    log(null, "result", `[REAL] Captured desktop screenshot ${o.width}×${o.height}`, false, true);
    return o;
  },

  resetAll() {
    timers.forEach((h) => clearTimeout(h));
    timers.clear();
    clearAll();
    set({ ...initial, hydrated: true });
    void actions.refreshConnection();
  },
};

function upsert<T extends { id: string }>(list: T[], item: T, originalId?: string): T[] {
  const key = originalId ?? item.id;
  return list.some((x) => x.id === key)
    ? list.map((x) => (x.id === key ? item : x))
    : [...list, item];
}
