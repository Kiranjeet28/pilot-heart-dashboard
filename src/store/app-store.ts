// Central app store + demo task runner. UI reads via useAppState; mutations go through `actions`.
import { useSyncExternalStore } from "react";
import type { AccountProfile, ActivityEvent, ActivityKind, AppSettings, DesktopTarget, Provider, Task, TaskStatus } from "@/lib/types";
import { DEFAULT_PROFILES, DEFAULT_PROVIDERS, DEFAULT_SETTINGS, DEFAULT_TARGETS } from "@/lib/registry/defaults";
import { canTransition, isActive } from "@/lib/tasks/state-machine";
import { planDemoSteps } from "@/lib/tasks/planner";
import { validateAction } from "@/lib/worker/action-validation";
import { MockDesktopWorker } from "@/lib/worker/mock-worker";
import type { DesktopWorker } from "@/lib/worker/worker";
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
  if (p.providers || p.profiles || p.targets) save("config", { providers: state.providers, profiles: state.profiles, targets: state.targets });
  if (p.tasks) save("tasks", state.tasks);
  if (p.activity) save("activity", state.activity);
  if (p.settings || "emergencyStop" in p) save("settings", { ...state.settings, emergencyStop: state.emergencyStop });
}

export const store = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useAppState<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(state), () => selector(initial));
}

// ---------- worker ----------
export const worker: DesktopWorker = new MockDesktopWorker({
  isConnected: () => state.settings.workerSimulation === "connected",
  failureRate: () => state.settings.failureRate,
});

// ---------- helpers ----------
let counter = 0;
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

function log(taskId: string | null, kind: ActivityKind, message: string, simulated = true) {
  const ev: ActivityEvent = { id: uid("ev"), taskId, timestamp: Date.now(), kind, message, simulated };
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
  timers.set(id, setTimeout(() => void tick(id), ms));
}

function fail(id: string, error: string) {
  if (transition(id, "failed", { error, summary: `Failed: ${error}` })) log(id, "error", error);
}

async function tick(id: string) {
  timers.delete(id);
  const t = getTask(id);
  if (!t || state.emergencyStop) return;
  try {
    if (t.status === "queued") {
      const h = await worker.healthCheck();
      if (getTask(id)?.status !== "queued") return;
      if (!h.ok) return fail(id, "Worker disconnected — health check failed");
      log(id, "info", `Worker health OK (${h.latencyMs} ms, demo)`);
      transition(id, "planning");
      log(id, "info", "Planning steps (demo planner — no AI provider call)");
      return schedule(id);
    }
    if (t.status === "planning") {
      const target = state.targets.find((x) => x.id === t.targetId);
      if (!target) return fail(id, "Desktop target no longer exists");
      const steps = planDemoSteps(t.description, target);
      transition(id, "running", { steps, currentStep: 0 });
      log(id, "info", `Plan ready: ${steps.length} simulated steps`);
      return schedule(id);
    }
    if (t.status !== "running") return;

    const step = t.steps[t.currentStep];
    if (!step) {
      transition(id, "completed", { progress: 100, summary: `Completed ${t.steps.length} simulated steps on ${state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId}. No real desktop actions were performed.` });
      log(id, "result", "Task completed (demo)");
      return;
    }
    if (step.requiresApproval && !step.approved) {
      transition(id, "waiting_for_approval");
      log(id, "approval", `Approval required: ${step.action.description}`);
      return;
    }
    const v = validateAction(step.action);
    if (!v.ok) return fail(id, `Action rejected by validator: ${v.reason}`);
    log(id, "action", `[SIMULATED] ${step.action.description}`);
    const result = await worker.executeAction(id, v.action);
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
    const obs = await worker.observe({ taskId: id, targetId: t.targetId, targetLabel: state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId, note: step.action.description });
    if (getTask(id)?.status !== "running") return;
    const next = t.currentStep + 1;
    patchTask(id, {
      currentStep: next,
      retries: 0,
      progress: Math.round((next / t.steps.length) * 100),
      steps: getTask(id)!.steps.map((s, i) => (i === t.currentStep ? { ...s, done: true } : s)),
      lastObservation: { imageDataUrl: obs.imageDataUrl, capturedAt: obs.capturedAt, simulated: obs.simulated },
    });
    log(id, "result", result.message);
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
    const restored = tasks.map((t) => (["queued", "planning", "running"].includes(t.status) ? { ...t, status: "paused" as const } : t));
    state = {
      ...state,
      ...(config ?? {}),
      tasks: restored,
      activity,
      settings: settings ? { workerSimulation: settings.workerSimulation, failureRate: settings.failureRate, stepDelayMs: settings.stepDelayMs } : DEFAULT_SETTINGS,
      emergencyStop: settings?.emergencyStop ?? false,
      hydrated: true,
    };
    listeners.forEach((l) => l());
    if (restored.some((t, i) => t.status !== tasks[i].status)) log(null, "warning", "Dashboard reloaded — in-flight tasks were paused");
  },

  readiness(i: Omit<NewTaskInput, "description">) {
    return checkReadiness({ ...i, ...state, worker: state.settings.workerSimulation });
  },

  createTask(input: NewTaskInput, start: boolean): { ok: true; id: string } | { ok: false; issues: string[] } {
    if (!input.description.trim()) return { ok: false, issues: ["Describe the task."] };
    if (input.description.length > 4000) return { ok: false, issues: ["Task description is too long (max 4000)."] };
    if (start) {
      const issues = actions.readiness(input);
      if (issues.length) return { ok: false, issues };
    }
    const task: Task = { id: uid("task"), ...input, description: input.description.trim(), status: "draft", createdAt: Date.now(), progress: 0, steps: [], currentStep: 0, retries: 0 };
    set((s) => ({ tasks: [task, ...s.tasks] }));
    log(task.id, "info", start ? "Task created" : "Draft saved", false);
    if (start) actions.start(task.id);
    return { ok: true, id: task.id };
  },

  start(id: string): string[] {
    const t = getTask(id);
    if (!t) return ["Task not found"];
    const issues = actions.readiness(t).filter((x) => !x.startsWith("Another task") || state.tasks.some((o) => o.id !== id && isActive(o.status)));
    if (issues.length) return issues;
    if (!transition(id, "queued", { startedAt: Date.now() })) return ["Task cannot be started from its current state"];
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
    if (state.settings.workerSimulation === "disconnected") return ["Worker is disconnected"];
    transition(id, t.steps.length ? "running" : "queued");
    log(id, "info", "Resumed by user", false);
    schedule(id, 300);
    return [];
  },

  cancel(id: string, reason = "Cancelled by user") {
    if (!transition(id, "cancelled", { summary: reason })) return;
    clearTimer(id);
    void worker.cancelTask(id);
    log(id, "warning", reason, false);
  },

  approve(id: string) {
    const t = getTask(id);
    if (!t || t.status !== "waiting_for_approval") return;
    patchTask(id, { steps: t.steps.map((s, i) => (i === t.currentStep ? { ...s, approved: true } : s)) });
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
    return actions.createTask({ description: t.description, providerId: t.providerId, profileId: t.profileId, targetId: t.targetId }, true);
  },

  deleteTask(id: string) {
    const t = getTask(id);
    if (!t || isActive(t.status)) return;
    set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id), activity: s.activity.filter((a) => a.taskId !== id) }));
  },

  emergencyStop() {
    timers.forEach((h) => clearTimeout(h));
    timers.clear();
    set({ emergencyStop: true });
    state.tasks.filter((t) => isActive(t.status)).forEach((t) => actions.cancel(t.id, "Cancelled by EMERGENCY STOP"));
    log(null, "safety", "EMERGENCY STOP engaged — all tasks halted, new tasks blocked", false);
  },

  resetEmergencyStop() {
    set({ emergencyStop: false });
    log(null, "safety", "Emergency stop reset", false);
  },

  updateSettings(p: Partial<AppSettings>) {
    set((s) => ({ settings: { ...s.settings, ...p } }));
    if (p.workerSimulation) log(null, p.workerSimulation === "connected" ? "info" : "warning", `Mock worker ${p.workerSimulation} (simulated)`);
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

  resetAll() {
    timers.forEach((h) => clearTimeout(h));
    timers.clear();
    clearAll();
    set({ ...initial, hydrated: true });
  },
};

function upsert<T extends { id: string }>(list: T[], item: T, originalId?: string): T[] {
  const key = originalId ?? item.id;
  return list.some((x) => x.id === key) ? list.map((x) => (x.id === key ? item : x)) : [...list, item];
}
