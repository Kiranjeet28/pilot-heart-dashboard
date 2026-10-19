export const PLAN_CHUNK_MAX_OUTPUT_TOKENS = 500;
export const PLAN_SIMPLE_MAX_OUTPUT_TOKENS = 256;
export const PLAN_CHUNK_MAX_COUNT = 8;
export const PLAN_MAX_TOTAL_STEPS = 12;
export const PLAN_MALFORMED_REPAIR_LIMIT = 1;

export interface TaskPlanChunk {
  id: string;
  description: string;
  dependsOn: string[];
}

export function getReadyChunks(
  chunks: TaskPlanChunk[],
  completedIds: Set<string>,
  scheduledIds: Set<string>,
): TaskPlanChunk[] {
  return chunks.filter(
    (chunk) =>
      !completedIds.has(chunk.id) &&
      !scheduledIds.has(chunk.id) &&
      chunk.dependsOn.every((dependency) => completedIds.has(dependency)),
  );
}

export interface TaskDecomposition {
  chunks: TaskPlanChunk[];
}

/**
 * Validate the decomposition before it can be used for planning.
 * Chunks describe planning work; they do not execute desktop actions.
 */
export function validateTaskDecomposition(value: unknown): TaskDecomposition {
  if (!value || typeof value !== "object") {
    throw new Error("Task decomposition must be an object.");
  }

  const candidate = value as { chunks?: unknown };

  if (
    !Array.isArray(candidate.chunks) ||
    candidate.chunks.length === 0 ||
    candidate.chunks.length > PLAN_CHUNK_MAX_COUNT
  ) {
    throw new Error(
      `Task decomposition must contain between 1 and ${PLAN_CHUNK_MAX_COUNT} chunks.`,
    );
  }

  const ids = new Set<string>();

  const chunks = candidate.chunks.map((item, index): TaskPlanChunk => {
    if (!item || typeof item !== "object") {
      throw new Error(`Chunk ${index + 1} must be an object.`);
    }

    const chunk = item as {
      id?: unknown;
      description?: unknown;
      dependsOn?: unknown;
    };

    if (
      typeof chunk.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(chunk.id) ||
      ids.has(chunk.id)
    ) {
      throw new Error(`Chunk ${index + 1} has an invalid or duplicate ID.`);
    }

    if (
      typeof chunk.description !== "string" ||
      chunk.description.trim().length === 0 ||
      chunk.description.length > 1000
    ) {
      throw new Error(`Chunk ${index + 1} has an invalid description.`);
    }

    if (
      !Array.isArray(chunk.dependsOn) ||
      !chunk.dependsOn.every((dependency): dependency is string => typeof dependency === "string")
    ) {
      throw new Error(`Chunk ${index + 1} has invalid dependencies.`);
    }

    ids.add(chunk.id);

    return {
      id: chunk.id,
      description: chunk.description.trim(),
      dependsOn: chunk.dependsOn,
    };
  });

  for (const chunk of chunks) {
    for (const dependency of chunk.dependsOn) {
      if (dependency === chunk.id || !ids.has(dependency)) {
        throw new Error(`Chunk "${chunk.id}" has an invalid dependency "${dependency}".`);
      }
    }
  }

  // Detect dependency cycles.
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visiting.has(id)) {
      throw new Error("Task chunks contain a dependency cycle.");
    }

    if (visited.has(id)) return;

    visiting.add(id);

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }

    visiting.delete(id);
    visited.add(id);
  }

  for (const chunk of chunks) visit(chunk.id);

  return { chunks };
}

import type { ProviderResult, AIProviderResult } from "@/lib/ai/provider";
import { simpleTaskHasDeterministicProgress } from "@/lib/tasks/simple-task";

export interface TaskPlanRequestInput {
  taskId?: string | undefined;
  userRequest: string;
  targetId?: string | undefined;
  providerId?: string | undefined;
  profileId?: string | undefined;
  context?: string[] | undefined;
  modelOverride?: string | undefined;
  timeoutMs?: number | undefined;
}

export const TASK_DECOMPOSITION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["chunks"],
  properties: {
    chunks: {
      type: "array",
      minItems: 1,
      maxItems: PLAN_CHUNK_MAX_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "dependsOn"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          dependsOn: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export function buildDecompositionPrompt(input: TaskPlanRequestInput): string {
  return [
    "Divide the user's desktop task into small planning chunks.",
    "Return JSON matching the provided schema only.",
    "Preserve the original task intent and selected target.",
    "Use dependencies when one chunk requires another to finish first.",
    "Do not invent screen coordinates or claim actions have been executed.",
    `Selected target: ${input.targetId ?? "desktop"}`,
    `User task: ${input.userRequest}`,
    ...(input.context?.length ? ["Context:", ...input.context.map((line) => `- ${line}`)] : []),
  ].join("\n");
}

export function mergeChunkPlans(
  plans: Array<{ chunkId: string; result: ProviderResult }>,
): ProviderResult {
  const steps = plans.flatMap(({ result }) => result.steps);

  if (steps.length === 0) {
    throw new Error("Chunk planning returned no executable steps.");
  }

  if (steps.length > PLAN_MAX_TOTAL_STEPS) {
    throw new Error(`Combined plan exceeds the ${PLAN_MAX_TOTAL_STEPS}-step limit.`);
  }

  return {
    ok: true,
    plan: plans.flatMap(({ result }) => result.plan),
    summary: plans.map(({ result }) => result.summary).join(" "),
    steps,
    requiresApproval: steps.some((step) => step.requiresApproval),
    nextAction: steps[0]?.action ?? null,
  };
}

export interface TaskBatchExecutionState {
  originalObjective?: string | undefined;
  remainingObjective: string;
  completedActionsSummary: string[];
  executedActionKinds?: string[] | undefined;
  latestObservation?: string | undefined;
  executionState?: Record<string, unknown> | undefined;
}

export interface TaskBatchOrchestratorOptions {
  maxBatches?: number | undefined;
  maxTotalSteps?: number | undefined;
  initialPlan?: ProviderResult | undefined;
}

/**
 * Format concise continuation context lines for subsequent planning batches.
 * Only includes original objective, remaining objective, concise summary of completed actions,
 * latest desktop observation, and essential execution state.
 */
export function buildBatchContinuationContext(continuation: TaskBatchExecutionState): string[] {
  const context: string[] = [];

  if (continuation.originalObjective?.trim()) {
    context.push(`Original task objective: ${continuation.originalObjective.trim()}`.slice(0, 500));
  }

  if (continuation.completedActionsSummary.length > 0) {
    context.push(
      `Completed actions: ${continuation.completedActionsSummary.join("; ")}`.slice(0, 500),
    );
  }

  if (continuation.latestObservation?.trim()) {
    context.push(`Latest observation: ${continuation.latestObservation.trim()}`.slice(0, 500));
  }

  if (continuation.executionState && Object.keys(continuation.executionState).length > 0) {
    context.push(`Execution state: ${JSON.stringify(continuation.executionState)}`.slice(0, 500));
  }

  return context;
}

/**
 * Constructs the next planning input for a continuation batch.
 * Does not resend full conversation or entire previous plans.
 */
export function buildNextPlanningBatchInput(
  baseInput: TaskPlanRequestInput,
  continuation: TaskBatchExecutionState,
): TaskPlanRequestInput {
  const originalObjective = continuation.originalObjective ?? baseInput.userRequest;
  const continuationContext = buildBatchContinuationContext({
    ...continuation,
    originalObjective,
  });

  return {
    ...baseInput,
    userRequest: continuation.remainingObjective,
    context: [
      ...(baseInput.context ?? []).filter(
        (line) =>
          !line.startsWith("Original task objective:") &&
          !line.startsWith("Completed actions:") &&
          !line.startsWith("Dependency plan:") &&
          !line.startsWith("Do not re-execute:") &&
          !line.startsWith("Latest observation:") &&
          !line.startsWith("Execution state:"),
      ),
      `Do not re-execute already completed actions: ${continuation.completedActionsSummary.join("; ")}`.slice(
        0,
        500,
      ),
      ...continuationContext,
    ].slice(0, 12),
  };
}

/**
 * Reliable task completion detector.
 * Confirms whether the original task objective has been achieved,
 * preventing premature completion simply because a batch finished.
 */
export function isTaskObjectiveComplete(
  summary?: string | undefined,
  plan?: string[] | undefined,
  remainingObjective?: string | undefined,
  options?:
    | {
        completedActionsCount?: number | undefined;
        totalPlanStepsCount?: number | undefined;
        batchesExecuted?: number | undefined;
        planSteps?: unknown[] | undefined;
      }
    | undefined,
): boolean {
  // Completion is a control signal, not a keyword search over model prose or
  // action descriptions. Only the planner's explicit leading marker counts.
  void plan;
  void remainingObjective;
  void options;
  return /^\s*\[complete\](?:\s|$)/i.test(summary ?? "");
}

/**
 * Requests another planning batch when the current batch has completed successfully
 * and the original task remains unfinished.
 *
 * Reuses existing planning logic without duplicating model request code.
 */
export async function requestNextPlanningBatch(
  baseInput: TaskPlanRequestInput,
  continuation: TaskBatchExecutionState,
  planFn?: ((input: TaskPlanRequestInput) => Promise<AIProviderResult>) | undefined,
): Promise<AIProviderResult> {
  const nextInput = buildNextPlanningBatchInput(baseInput, continuation);

  if (planFn) {
    return planFn(nextInput);
  }

  const res = await fetch("/api/tasks/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nextInput),
  });
  if (!res.ok) {
    throw new Error(`Planning batch request failed: ${res.statusText}`);
  }
  return res.json();
}

export interface TaskBatchExecutionHandlers {
  planBatch: (input: TaskPlanRequestInput) => Promise<AIProviderResult>;
  validateAction: (action: unknown) => { ok: boolean; reason?: string | undefined };
  executeAction: (
    action: unknown,
  ) => Promise<{ ok: boolean; message?: string | undefined; error?: string | undefined }>;
  observeDesktop: () => Promise<{
    ok: boolean;
    observation?: string | undefined;
    observationId?: string | undefined;
    stale?: boolean | undefined;
  }>;
  isCancelled?: (() => boolean) | undefined;
  isDeadlineExceeded?: (() => boolean) | undefined;
  requiresApproval?: ((step: unknown) => boolean) | undefined;
  onApprovalRequired?: ((step: unknown) => Promise<boolean>) | undefined;
  onBatchStart?: ((batchIndex: number, result: ProviderResult) => void) | undefined;
  onBatchComplete?: ((batchIndex: number, result: ProviderResult) => void) | undefined;
  onActionStart?: ((step: unknown, actionIndex: number) => void) | undefined;
  onActionComplete?:
    | ((
        step: unknown,
        actionIndex: number,
        result: { ok: boolean; message?: string | undefined },
      ) => void)
    | undefined;
  isTaskComplete?:
    ((state: TaskBatchExecutionState, planResult: ProviderResult) => boolean) | undefined;
  getRemainingObjective?:
    ((state: TaskBatchExecutionState, planResult: ProviderResult) => string) | undefined;
}

export interface TaskBatchOrchestrationResult {
  completed: boolean;
  batchesExecuted: number;
  totalActionsExecuted: number;
  stoppedReason?:
    | "completed"
    | "unverified"
    | "cancelled"
    | "approval_required"
    | "action_failed"
    | "observation_failed"
    | "validation_failed"
    | "deadline_exceeded"
    | "error"
    | undefined;
  error?: string | undefined;
  lastObservation?: string | undefined;
  completedActionsSummary: string[];
}

/**
 * Orchestrates batched task execution:
 * 1. Generates a batch.
 * 2. Validates the entire batch before executing it.
 * 3. Executes validated actions using worker safety checks.
 * 4. Observes desktop after the batch completes.
 * 5. Evaluates whether the original objective is complete.
 * 6. Continues until task completion, cancellation, approval requirement, deadline, or error.
 */
export async function orchestrateTaskBatches(
  initialInput: TaskPlanRequestInput,
  handlers: TaskBatchExecutionHandlers,
  options?: TaskBatchOrchestratorOptions,
): Promise<TaskBatchOrchestrationResult> {
  const maxBatches = options?.maxBatches ?? PLAN_CHUNK_MAX_COUNT;
  const maxTotalSteps = options?.maxTotalSteps ?? PLAN_MAX_TOTAL_STEPS;
  const originalObjective = initialInput.userRequest;

  let batchesExecuted = 0;
  let totalActionsExecuted = 0;
  const completedActionsSummary: string[] = [];
  const executedActionKinds: string[] = [];
  const executedActionKeys = new Set<string>();
  let latestObservation: string | undefined;
  let remainingObjective = originalObjective;

  while (batchesExecuted < maxBatches && totalActionsExecuted < maxTotalSteps) {
    if (handlers.isCancelled?.()) {
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "cancelled",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    if (handlers.isDeadlineExceeded?.()) {
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "deadline_exceeded",
        error: "Task execution timed out (deadline exceeded)",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    const currentBatchInput =
      batchesExecuted === 0
        ? initialInput
        : buildNextPlanningBatchInput(initialInput, {
            originalObjective,
            remainingObjective,
            completedActionsSummary,
            latestObservation,
          });

    // 2. Obtain the next batch of at most 3 actions (reuse initial plan if provided, or ask planner).
    let planResult: AIProviderResult;
    if (
      batchesExecuted === 0 &&
      options?.initialPlan &&
      options.initialPlan.ok &&
      options.initialPlan.steps.length > 0
    ) {
      planResult = options.initialPlan;
    } else {
      planResult = await handlers.planBatch(currentBatchInput);
    }

    if (!planResult.ok) {
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "error",
        error: planResult.message ?? "Planning batch failed",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    // An empty plan is not evidence that the objective was achieved. This can also
    // happen when a planner cannot safely continue (for example, it cannot ground a click).
    if (planResult.steps.length === 0) {
      if (batchesExecuted > 0) {
        return {
          completed: false,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "unverified",
          error: planResult.summary?.trim() || "The planner provided no follow-up action or verification.",
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "error",
        error: planResult.summary?.trim()
          ? `Planning returned no executable steps; objective was not verified. ${planResult.summary.trim()}`
          : "Planning returned no executable steps; objective was not verified.",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    // Enforce at most 3 actions per planning response batch.
    const batchSteps = planResult.steps.slice(0, 3);

    for (const step of planResult.steps) {
      const validation = handlers.validateAction(step.action);

      if (!validation.ok) {
        return {
          completed: false,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "validation_failed",
          error: `Action rejected by validator: ${validation.reason ?? "unsupported action"}`,
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }
    }

    // Notify batch start after full-batch validation passes.
    handlers.onBatchStart?.(batchesExecuted + 1, planResult);

    // 4. Execute only validated actions, using existing worker safety checks.
    let batchActionsExecuted = 0;
    for (const step of batchSteps) {
      if (handlers.isCancelled?.()) {
        return {
          completed: false,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "cancelled",
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }

      if (handlers.isDeadlineExceeded?.()) {
        return {
          completed: false,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "deadline_exceeded",
          error: "Task execution timed out (deadline exceeded)",
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }

      const actionKey = JSON.stringify({
        kind: step.action.kind,
        targetId: step.action.targetId,
        text: (step.action as { text?: string }).text,
        keys: (step.action as { keys?: string }).keys,
        x: (step.action as { x?: number }).x,
        y: (step.action as { y?: number }).y,
      });

      // Prevent duplicate action execution during batch continuations
      if (
        executedActionKeys.has(actionKey) &&
        step.action.kind !== "wait" &&
        step.action.kind !== "read_screen"
      ) {
        continue;
      }

      if (step.requiresApproval || handlers.requiresApproval?.(step)) {
        if (handlers.onApprovalRequired) {
          const approved = await handlers.onApprovalRequired(step);
          if (!approved) {
            return {
              completed: false,
              batchesExecuted,
              totalActionsExecuted,
              stoppedReason: "approval_required",
              completedActionsSummary,
              lastObservation: latestObservation,
            };
          }
        } else {
          return {
            completed: false,
            batchesExecuted,
            totalActionsExecuted,
            stoppedReason: "approval_required",
            completedActionsSummary,
            lastObservation: latestObservation,
          };
        }
      }

      // The observation ID is provenance from planning; never attach a new ID here.
      if (step.action.kind === "click") {
        const clickAction = step.action as { observationId?: string };
        if (!clickAction.observationId) {
          return {
            completed: false,
            batchesExecuted,
            totalActionsExecuted,
            stoppedReason: "validation_failed",
            error: "Click has no observation ID from the screenshot used to ground its coordinates.",
            completedActionsSummary,
            lastObservation: latestObservation,
          };
        }
      }

      handlers.onActionStart?.(step, totalActionsExecuted);

      // A failed/unknown worker reply may mean the action executed but its response was lost.
      // Never resend desktop actions automatically; a duplicate can be destructive.
      const actionResult = await handlers.executeAction(step.action);

      handlers.onActionComplete?.(step, totalActionsExecuted, actionResult);

      if (!actionResult.ok) {
        return {
          completed: false,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "action_failed",
          error: actionResult.error ?? actionResult.message ?? "Action execution failed",
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }

      batchActionsExecuted++;
      totalActionsExecuted++;
      executedActionKeys.add(actionKey);
      executedActionKinds.push(step.action.kind);
      const actionDesc = (step.action as { description?: string })?.description ?? step.action.kind;
      completedActionsSummary.push(actionDesc);
    }

    // 5. Observe the desktop after the batch completes.
    const obs = await handlers.observeDesktop();
    if (!obs.ok || obs.stale) {
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "observation_failed",
        error: obs.stale
          ? "Observation is stale after batch completion; refusing to continue blindly"
          : "Desktop observation failed after batch",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }
    latestObservation = obs.observation;

    batchesExecuted++;
    handlers.onBatchComplete?.(batchesExecuted, planResult);

    // Loop-progress guard: if no actions were executed in this batch (all duplicates)
    if (batchActionsExecuted === 0 && batchSteps.length > 0) {
      const state: TaskBatchExecutionState = {
        originalObjective,
        remainingObjective,
        completedActionsSummary,
        latestObservation,
      };
      const isComplete = handlers.isTaskComplete
        ? handlers.isTaskComplete(state, planResult)
        : isTaskObjectiveComplete(planResult.summary, planResult.plan, remainingObjective, {
            completedActionsCount: completedActionsSummary.length,
            batchesExecuted,
            planSteps: planResult.steps,
          });
      if (isComplete) {
        return {
          completed: true,
          batchesExecuted,
          totalActionsExecuted,
          stoppedReason: "completed",
          completedActionsSummary,
          lastObservation: latestObservation,
        };
      }
      return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "error",
        error:
          "Task loop stopped: no progress was made in the latest planning batch (all actions were duplicates)",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    // 6. Evaluate whether the original objective is actually complete.
    const state: TaskBatchExecutionState = {
      originalObjective,
      remainingObjective,
      completedActionsSummary,
      executedActionKinds,
      latestObservation,
    };

    const deterministicComplete = simpleTaskHasDeterministicProgress(
      originalObjective,
      executedActionKinds,
      Boolean(latestObservation) || obs.ok,
    );

    const isComplete = deterministicComplete
      ? true
      : handlers.isTaskComplete
        ? handlers.isTaskComplete(state, planResult)
        : isTaskObjectiveComplete(planResult.summary, planResult.plan, remainingObjective, {
            completedActionsCount: completedActionsSummary.length,
            batchesExecuted,
            planSteps: planResult.steps,
          });

    // 7. If complete, finish the task using the existing completion mechanism.
    if (isComplete) {
      return {
        completed: true,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: "completed",
        completedActionsSummary,
        lastObservation: latestObservation,
      };
    }

    // 8. If incomplete, update remaining objective using concise progress
    if (handlers.getRemainingObjective) {
      remainingObjective = handlers.getRemainingObjective(state, planResult);
    } else {
      const recentActions = batchSteps.map(
        (s) => (s.action as { description?: string })?.description ?? s.action.kind,
      );
      remainingObjective =
        `Remaining objective for: ${originalObjective} (completed so far: ${recentActions.join(", ")})`.slice(
          0,
          500,
        );
    }
  }

  return {
    completed: false,
    batchesExecuted,
    totalActionsExecuted,
    stoppedReason: "error",
    error:
      totalActionsExecuted >= maxTotalSteps
        ? `Exceeded max total steps (${maxTotalSteps}) before confirming task completion`
        : `Reached max batches (${maxBatches}) before confirming task completion`,
    completedActionsSummary,
    lastObservation: latestObservation,
  };
}
