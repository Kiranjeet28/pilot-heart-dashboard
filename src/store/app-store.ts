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
import { MockAIProvider } from "@/lib/ai/provider";
import { verifyActionOutcome } from "@/lib/tasks/verification";
import {
  MAX_REPLANS,
  approvedScopeFrom,
  buildReplanContext,
  canReplan,
  isWithinApprovedScope,
  mergeRemaining,
  parseRetryAfterSeconds,
  shouldCheckAfter,
} from "@/lib/tasks/adapt";
import { requestStepCheck } from "@/lib/ai/step-check-client";
import { configureAiRouting, routedProvider } from "@/lib/ai/aiProvider";
import { validateAction, type ValidatedActionRequest } from "@/lib/worker/action-validation";
import { MockDesktopWorker } from "@/lib/worker/mock-worker";
import type { ActionResult, DesktopWorker, ObservationResult } from "@/lib/worker/worker";
import { LocalHttpWorker } from "@/lib/worker/local-worker";
import { clearSession, readSession, writeSession } from "@/lib/worker/token-store";
import { WorkerUnavailableError } from "@/lib/worker/worker";
import { clearAll, load, save } from "@/lib/persistence/local-store";
import { checkReadiness } from "@/lib/safety/readiness";
import {
  PLAN_CHUNK_MAX_COUNT,
  PLAN_MAX_TOTAL_STEPS,
  isTaskObjectiveComplete,
  orchestrateTaskBatches,
} from "@/lib/tasks/task-plan-orchestrator";

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
/** One AbortController per task so Cancel/Stop also aborts an in-flight local model call. */
const aiAborts = new Map<string, AbortController>();
function aiAbortFor(id: string): AbortSignal {
  let c = aiAborts.get(id);
  if (!c || c.signal.aborted) {
    c = new AbortController();
    aiAborts.set(id, c);
  }
  return c.signal;
}
configureAiRouting(() => ({
  mode: state.settings.aiMode,
  localBaseUrl: state.settings.localBaseUrl,
}));
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
  batchStates.delete(id);
  if (transition(id, "failed", { error, summary: `Failed: ${error}` }))
    log(id, "error", error, sim, !sim);
}

/**
 * Module 4 see-and-adapt: after a screen-changing step, check the screenshot and,
 * when the screen is off track, replan the remaining steps inside the approved scope.
 * Returns "handled" when it has already moved the task on (replanned or failed).
 */
/** Tasks whose screen checks were paused after an AI quota error (not persisted). */
const checksPaused = new Set<string>();

interface TaskBatchState {
  remainingObjective: string;
  completedActionsSummary: string[];
  executedActionKeys: Set<string>;
  latestObservationText?: string;
  batchCount: number;
}
const batchStates = new Map<string, TaskBatchState>();

async function checkAndAdapt(
  id: string,
  action: ActionRequest,
  obs: ObservationResult | undefined,
  sim: boolean,
): Promise<"continue" | "handled"> {
  const stillVerifying = () => getTask(id)?.status === "verifying" && !state.emergencyStop;
  if (sim) {
    patchTask(id, {
      lastCheck: {
        verdict: "ok",
        reason: "Simulated check",
        screenSummary: "Target window visible and active",
        simulated: true,
        checkedAt: Date.now(),
      },
    });
    log(id, "info", "Screen check (simulated): looks right — no screen sent to AI", true);
    return "continue";
  }
  if (!obs?.imageDataUrl || obs.simulated) {
    log(
      id,
      "warning",
      "Could not tell — no real screenshot to check. Recorded as unverified.",
      false,
      true,
    );
    return "continue";
  }
  if (checksPaused.has(id)) return "continue";
  const t = getTask(id)!;
  log(id, "info", "Checking the screen…", false, true);
  const check = await requestStepCheck({
    taskId: id,
    targetId: t.targetId,
    taskRequest: t.description,
    stepDescription: action.description,
    imageDataUrl: obs.imageDataUrl,
  });
  if (!stillVerifying()) return "handled";
  if (check.rateLimited) {
    checksPaused.add(id);
    log(
      id,
      "warning",
      "AI quota reached — screen checks are paused for the rest of this task so the plan can keep running. Steps are recorded as unverified.",
      false,
      true,
    );
  }
  patchTask(id, {
    lastCheck: {
      verdict: check.verdict,
      reason: check.reason,
      ...(check.screenSummary ? { screenSummary: check.screenSummary } : {}),
      simulated: false,
      checkedAt: Date.now(),
    },
  });
  if (check.verdict === "ok") {
    log(id, "result", `Looks right: ${check.reason}`, false, true);
    return "continue";
  }
  if (check.verdict === "unsure") {
    patchTask(id, {
      verification: { status: "unverified", reason: check.reason, checkedAt: Date.now() },
    });
    log(
      id,
      "warning",
      `Could not tell: ${check.reason}. Recorded as unverified — continuing.`,
      false,
      true,
    );
    return "continue";
  }
  log(id, "warning", `Unexpected screen — adjusting plan: ${check.reason}`, false, true);
  const cur = getTask(id)!;
  if (!canReplan(cur.replans)) {
    fail(
      id,
      `The screen was still off track after ${MAX_REPLANS} plan adjustments: ${check.reason}`,
    );
    return "handled";
  }
  const target = state.targets.find((x) => x.id === cur.targetId);
  const provider = state.providers.find((x) => x.id === cur.providerId);
  const profile = state.profiles.find((x) => x.id === cur.profileId);
  if (!target || !provider || !profile || !cur.approvedScope) {
    fail(id, "Cannot adjust the plan: task settings are missing");
    return "handled";
  }
  const ask = () =>
    routedProvider(provider, profile, aiAbortFor(id)).getNextStep({
      taskId: id,
      userRequest: cur.description,
      targetId: cur.targetId,
      provider,
      profile,
      context: buildReplanContext(cur.steps, cur.currentStep, check),
    });
  const planned = await ask();
  if (!stillVerifying()) return "handled";
  if (!planned.ok) {
    fail(id, `Could not adjust the plan: ${planned.message}`);
    return "handled";
  }
  let remaining;
  try {
    remaining = normalizeProviderPlan(planned, target);
  } catch (e) {
    fail(id, `Adjusted plan rejected: ${e instanceof Error ? e.message : "invalid plan"}`);
    return "handled";
  }
  const scope = isWithinApprovedScope(remaining, cur.approvedScope);
  if (!scope.ok) {
    fail(
      id,
      `The plan needed actions you didn't approve (${scope.reason}). Start the task again to review them.`,
    );
    return "handled";
  }
  const merged = mergeRemaining(cur.steps, cur.currentStep, remaining);
  if (!merged.ok) {
    fail(id, `Could not adjust the plan: ${merged.reason}`);
    return "handled";
  }
  const before =
    cur.steps
      .slice(cur.currentStep + 1)
      .map((s) => s.action.description)
      .join(" → ") || "(nothing)";
  const after = remaining.map((s) => s.action.description).join(" → ");
  const next = cur.currentStep + 1;
  transition(id, "running");
  patchTask(id, {
    steps: merged.steps,
    currentStep: next,
    retries: 0,
    replans: (cur.replans ?? 0) + 1,
    progress: Math.round((next / merged.steps.length) * 100),
    currentAction: undefined,
  });
  log(
    id,
    "info",
    `Plan adjusted (${(cur.replans ?? 0) + 1}/${MAX_REPLANS}). Before: ${before}. Now: ${after}`,
    false,
    true,
  );
  schedule(id);
  return "handled";
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
      log(id, "info", sim ? "Preparing demo plan" : "Preparing real desktop plan", sim);
      return schedule(id);
    }
    if (t.status === "planning") {
      const target = state.targets.find((x) => x.id === t.targetId);
      if (!target) return fail(id, "Desktop target no longer exists");
      const provider = state.providers.find((x) => x.id === t.providerId);
      const profile = state.profiles.find((x) => x.id === t.profileId);
      if (!provider || !profile) return fail(id, "Task provider or profile no longer exists");

      let bState = batchStates.get(id);
      if (!bState) {
        bState = {
          remainingObjective: t.description,
          completedActionsSummary: [],
          executedActionKeys: new Set<string>(),
          batchCount: 0,
        };
        batchStates.set(id, bState);
      }

      transition(id, "running");

      const orchestrationResult = await orchestrateTaskBatches(
        {
          taskId: id,
          userRequest: bState.remainingObjective,
          targetId: t.targetId,
          providerId: t.providerId,
          profileId: t.profileId,
          context: [
            ...(t.context ? [`Project context from the user: ${t.context.slice(0, 480)}`] : []),
            ...(t.lastVerifiedResult ? [t.lastVerifiedResult] : []),
          ],
        },
        {
          planBatch: async (input) => {
            const batchNum = (bState?.batchCount ?? 0) + 1;
            log(
              id,
              "info",
              sim
                ? `Planning batch ${batchNum} with mock provider`
                : `Planning batch ${batchNum} with ${provider.displayName}`,
              sim,
            );
            return sim
              ? new MockAIProvider().getNextStep({
                  taskId: id,
                  userRequest: input.userRequest,
                  targetId: t.targetId,
                  provider,
                  profile,
                })
              : routedProvider(provider, profile, aiAbortFor(id)).getNextStep({
                  taskId: id,
                  userRequest: input.userRequest,
                  targetId: t.targetId,
                  provider,
                  profile,
                  context: input.context,
                });
          },
          validateAction: (action) => {
            const v = validateAction(action as ActionRequest, { strict: !sim, screen: state.connection.screen });
            return v.ok ? { ok: true } : { ok: false, reason: v.reason };
          },
          onBatchStart: (batchIndex, result) => {
            if (bState) bState.batchCount = batchIndex;
            const existingSteps = getTask(id)?.steps ?? [];
            const rawNormalized = normalizeProviderPlan(result, target);
            const batchSteps = rawNormalized.slice(0, 3);
            const combinedSteps = [...existingSteps, ...batchSteps];
            patchTask(id, {
              steps: combinedSteps,
              currentStep: existingSteps.length,
              approvedScope: approvedScopeFrom(combinedSteps, t.targetId),
            });
            log(
              id,
              "info",
              `Batch ${batchIndex} ready: ${batchSteps.length} step(s) (${combinedSteps.length} total)`,
              sim,
            );
          },
          onActionStart: (step, actionIndex) => {
            const act = (step as { action: ActionRequest }).action;
            patchTask(id, {
              currentAction: act,
              currentStep: actionIndex,
              verification: { status: "pending" },
            });
            log(id, "action", `${tag} ${act.description}`, sim, !sim);
          },
          executeAction: async (action) => {
            const act = action as ActionRequest;
            let result: ActionResult;
            let realObs: ObservationResult | undefined;
            if (!sim && act.kind === "read_screen") {
              realObs = await w.observe({ taskId: id, targetId: t.targetId, targetLabel: t.targetId });
              result = {
                ok: true,
                message: "Captured real desktop screenshot",
                simulated: false,
                completedAt: realObs.capturedAt,
              };
            } else {
              result = await w.executeAction(id, act as ValidatedActionRequest);
            }
            if (!result.ok) {
              return { ok: false, error: result.message, message: result.message };
            }

            const obs =
              sim || !realObs
                ? await w.observe({
                    taskId: id,
                    targetId: t.targetId,
                    targetLabel: state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId,
                    note: act.description,
                  })
                : realObs;

            const curStep = getTask(id)?.steps.find((s) => s.action.description === act.description);
            const verification = verifyActionOutcome(
              act,
              {
                ok: result.ok,
                message: result.message,
                result: obs?.imageDataUrl,
                ...(result.text ? { text: result.text } : {}),
                ...(result.data ? { data: result.data } : {}),
              },
              curStep?.verification,
            );

            patchTask(id, {
              verification: {
                status: verification.status,
                reason: verification.reason,
                checkedAt: Date.now(),
              },
              lastVerifiedResult: verification.evidence ?? verification.reason,
            });

            if (verification.status === "failed") {
              return {
                ok: false,
                error: `${verification.reason} (verification failed)`,
                message: verification.reason,
              };
            }

            if (state.settings.adaptiveChecks !== false && shouldCheckAfter(act.kind)) {
              await checkAndAdapt(id, act, obs, sim);
            }

            return {
              ok: true,
              message: result.message,
            };
          },
          onActionComplete: (step, actionIndex, actionResult) => {
            const curTask = getTask(id);
            if (!curTask) return;
            const updatedSteps = curTask.steps.map((s, i) =>
              i === actionIndex ? { ...s, done: true } : s,
            );
            patchTask(id, {
              steps: updatedSteps,
              currentStep: actionIndex + 1,
              progress: Math.min(100, Math.round(((actionIndex + 1) / PLAN_MAX_TOTAL_STEPS) * 100)),
              currentAction: undefined,
            });
            log(id, "result", `${sim ? "" : "[REAL] "}${actionResult.message ?? "Action complete"}`, sim, !sim);
          },
          observeDesktop: async () => {
            try {
              const targetLabel = state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId;
              const obs = await w.observe({
                taskId: id,
                targetId: t.targetId,
                targetLabel,
                note: "Batch observation",
              });
              if (obs) {
                patchTask(id, {
                  lastObservation: {
                    imageDataUrl: obs.imageDataUrl,
                    capturedAt: obs.capturedAt,
                    simulated: obs.simulated,
                    ...(obs.width ? { width: obs.width, height: obs.height } : {}),
                  },
                });

                const curTask = getTask(id);
                const dims = obs.width && obs.height ? ` (${obs.width}x${obs.height})` : "";
                const obsId = obs.observationId ? ` [id:${obs.observationId}]` : "";
                const evidence = curTask?.lastVerifiedResult ? ` Evidence: ${curTask.lastVerifiedResult}.` : "";
                const screenVisual = curTask?.lastCheck?.screenSummary
                  ? ` Visual: ${curTask.lastCheck.screenSummary}.`
                  : curTask?.lastCheck?.reason
                    ? ` Check: ${curTask.lastCheck.reason}.`
                    : "";
                const simNote = obs.simulated ? " (simulated)" : "";

                const structuredObs = `Target: ${targetLabel}${dims}${obsId} at ${obs.capturedAt}${simNote}.${evidence}${screenVisual}`.slice(0, 500);

                if (bState) {
                  bState.latestObservationText = structuredObs;
                }
                return {
                  ok: true,
                  observation: structuredObs,
                  observationId: obs.observationId,
                  stale: false,
                };
              }
              return { ok: false, stale: true };
            } catch {
              return { ok: false, stale: true };
            }
          },
          isCancelled: () => Boolean(state.emergencyStop || getTask(id)?.status === "cancelled"),
          isDeadlineExceeded: () => Boolean(t.deadlineAt && Date.now() >= t.deadlineAt),
          requiresApproval: (step) => {
            const s = step as PlannedStep;
            if (!sim && !state.realActionsConfirmed) return true;
            if (!getTask(id)?.planApproved && s.requiresApproval) return true;
            return false;
          },
          onApprovalRequired: async () => {
            transition(id, "waiting_for_approval");
            log(id, "approval", "Approval required before action execution", sim);
            return false;
          },
          isTaskComplete: (state, planResult) =>
            isTaskObjectiveComplete(
              planResult.summary,
              planResult.plan,
              state.remainingObjective,
            ),
        },
        {
          maxBatches: PLAN_CHUNK_MAX_COUNT,
          maxTotalSteps: PLAN_MAX_TOTAL_STEPS,
          maxRetriesPerAction: t.maxRetries ?? 2,
        },
      );

      if (getTask(id)?.status !== "running" && getTask(id)?.status !== "planning") return;

      if (orchestrationResult.stoppedReason === "completed") {
        const tname = state.targets.find((x) => x.id === t.targetId)?.displayName ?? t.targetId;
        transition(id, "completed", {
          progress: 100,
          summary: sim
            ? `Completed ${orchestrationResult.totalActionsExecuted} simulated steps across ${orchestrationResult.batchesExecuted} batch(es) on ${tname}. Task objective achieved.`
            : `Completed ${orchestrationResult.totalActionsExecuted} real worker steps across ${orchestrationResult.batchesExecuted} batch(es). Task objective achieved.`,
        });
        log(
          id,
          "result",
          sim ? "Task completed (demo)" : "Task completed (real local worker)",
          sim,
          !sim,
        );
        batchStates.delete(id);
      } else if (orchestrationResult.stoppedReason === "cancelled") {
        transition(id, "cancelled");
        log(id, "warning", "Task was cancelled", sim);
        batchStates.delete(id);
      } else if (orchestrationResult.stoppedReason === "approval_required") {
        // Paused in waiting_for_approval; batchStates is retained for resumption when approved.
      } else if (orchestrationResult.stoppedReason === "deadline_exceeded") {
        fail(id, "Task execution timed out");
      } else {
        fail(id, orchestrationResult.error ?? "Task execution failed");
      }
      return;
    }

    if (t.status === "running") {
      transition(id, "planning");
      return schedule(id);
    }
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
  /** Optional per-task limits (Prompt Workspace). Clamped to safe bounds. */
  maxMinutes?: number;
  maxRetries?: number;
  /** Optional project context shown on the task detail page. */
  context?: string;
}

export const clampMinutes = (m?: number) => Math.min(30, Math.max(1, Math.round(m ?? 10)));
export const clampRetries = (r?: number) => Math.min(2, Math.max(0, Math.round(r ?? 2)));

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
            adaptiveChecks: settings.adaptiveChecks ?? DEFAULT_SETTINGS.adaptiveChecks,
            aiMode: settings.aiMode ?? DEFAULT_SETTINGS.aiMode,
            localBaseUrl: settings.localBaseUrl ?? DEFAULT_SETTINGS.localBaseUrl,
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
    const { maxMinutes, maxRetries, context, ...base } = input;
    const ctx = context?.trim().slice(0, 2000);
    const task: Task = {
      id: uid("task"),
      ...base,
      description: input.description.trim(),
      ...(ctx ? { context: ctx } : {}),
      maxRetries: clampRetries(maxRetries),
      status: "draft",
      createdAt: Date.now(),
      progress: 0,
      steps: [],
      currentStep: 0,
      retries: 0,
      replans: 0,
      deadlineAt: Date.now() + clampMinutes(maxMinutes) * 60 * 1000,
    };
    set((s) => ({ tasks: [task, ...s.tasks] }));
    log(task.id, "info", start ? "Task created" : "Draft saved", false);
    if (start) actions.start(task.id);
    return { ok: true, id: task.id };
  },

  start(id: string): string[] {
    const t = getTask(id);
    if (!t) return ["Task not found"];
    if (isActive(t.status)) return ["Task is already active"];
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
    batchStates.delete(id);
    aiAborts.get(id)?.abort();
    aiAborts.delete(id);
    void currentWorker().cancelTask(id);
    log(id, "warning", reason, false);
  },

  approve(id: string) {
    const t = getTask(id);
    if (!t || t.status !== "waiting_for_approval") return;
    if (isReal()) set({ realActionsConfirmed: true });
    patchTask(id, {
      planApproved: true,
      steps: t.steps.map((s) => ({ ...s, approved: true })),
    });
    transition(id, "running");
    log(id, "approval", "Plan approved by user — task will run without further prompts", false);
    schedule(id, 300);
  },

  reject(id: string) {
    actions.cancel(id, "Plan rejected by user — task cancelled");
  },

  retry(id: string) {
    const t = getTask(id);
    if (!t) return { ok: false as const, issues: ["Task not found"] };
    return actions.createTask(
      {
        description: t.description,
        ...(t.context ? { context: t.context } : {}),
        ...(t.maxRetries !== undefined ? { maxRetries: t.maxRetries } : {}),
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
