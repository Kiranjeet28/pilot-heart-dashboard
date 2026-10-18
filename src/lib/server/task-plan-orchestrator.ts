
export const PLAN_CHUNK_MAX_OUTPUT_TOKENS = 500;
export const PLAN_CHUNK_MAX_COUNT = 8;
export const PLAN_MAX_TOTAL_STEPS = 12;

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
            chunk.dependsOn.every((dependency) =>
                completedIds.has(dependency),
            ),
    );
}
export interface TaskDecomposition {
    chunks: TaskPlanChunk[];
}

/**
 * Validate the decomposition before it can be used for planning.
 * Chunks describe planning work; they do not execute desktop actions.
 */
export function validateTaskDecomposition(
    value: unknown,
): TaskDecomposition {
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
            !chunk.dependsOn.every(
                (dependency): dependency is string =>
                    typeof dependency === "string",
            )
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
                throw new Error(
                    `Chunk "${chunk.id}" has an invalid dependency "${dependency}".`,
                );
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

import type { ProviderResult } from "@/lib/ai/provider";
import type { TaskPlanRequestInput } from "@/lib/server/task-plan";

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

export function buildDecompositionPrompt(
    input: TaskPlanRequestInput,
): string {
    return [
        "Divide the user's desktop task into small planning chunks.",
        "Return JSON matching the provided schema only.",
        "Preserve the original task intent and selected target.",
        "Use dependencies when one chunk requires another to finish first.",
        "Do not invent screen coordinates or claim actions have been executed.",
        `Selected target: ${input.targetId ?? "desktop"}`,
        `User task: ${input.userRequest}`,
        ...(input.context?.length
            ? ["Context:", ...input.context.map((line) => `- ${line}`)]
            : []),
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
        throw new Error(
            `Combined plan exceeds the ${PLAN_MAX_TOTAL_STEPS}-step limit.`,
        );
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
    remainingObjective: string;
    completedActionsSummary: string[];
    latestObservation?: string;
    executionState?: Record<string, unknown>;
}

export interface TaskBatchOrchestratorOptions {
    maxBatches?: number;
    maxTotalSteps?: number;
}

/**
 * Format concise continuation context lines for subsequent planning batches.
 * Only includes remaining objective, concise summary of completed actions,
 * latest desktop observation, and essential execution state.
 */
export function buildBatchContinuationContext(
    continuation: TaskBatchExecutionState,
): string[] {
    const context: string[] = [];

    if (continuation.completedActionsSummary.length > 0) {
        context.push(
            `Completed actions: ${continuation.completedActionsSummary.join("; ")}`.slice(0, 500),
        );
    }

    if (continuation.latestObservation?.trim()) {
        context.push(
            `Latest observation: ${continuation.latestObservation.trim()}`.slice(0, 500),
        );
    }

    if (
        continuation.executionState &&
        Object.keys(continuation.executionState).length > 0
    ) {
        context.push(
            `Execution state: ${JSON.stringify(continuation.executionState)}`.slice(0, 500),
        );
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
    const continuationContext = buildBatchContinuationContext(continuation);

    return {
        ...baseInput,
        userRequest: continuation.remainingObjective,
        context: [
            ...(baseInput.context ?? []).filter(
                (line) =>
                    !line.startsWith("Completed actions:") &&
                    !line.startsWith("Dependency plan:"),
            ),
            ...continuationContext,
        ].slice(0, 12),
    };
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
    planFn?: (input: TaskPlanRequestInput) => Promise<ProviderResult>,
): Promise<ProviderResult> {
    const nextInput = buildNextPlanningBatchInput(baseInput, continuation);

    if (planFn) {
        return planFn(nextInput);
    }

    const { generateTaskPlan } = await import("@/lib/server/task-plan");
    return generateTaskPlan(nextInput);
}

export interface TaskBatchExecutionHandlers {
    planBatch: (input: TaskPlanRequestInput) => Promise<ProviderResult>;
    validateAction: (action: unknown) => { ok: boolean; reason?: string };
    executeAction: (action: unknown) => Promise<{ ok: boolean; message?: string; error?: string }>;
    observeDesktop: () => Promise<{ ok: boolean; observation?: string; stale?: boolean }>;
    isCancelled?: () => boolean;
    requiresApproval?: (step: unknown) => boolean;
    onApprovalRequired?: (step: unknown) => Promise<boolean>;
    onBatchComplete?: (batchIndex: number, result: ProviderResult) => void;
    isTaskComplete: (state: TaskBatchExecutionState) => boolean;
}

export interface TaskBatchOrchestrationResult {
    completed: boolean;
    batchesExecuted: number;
    totalActionsExecuted: number;
    stoppedReason?:
        | "completed"
        | "cancelled"
        | "approval_required"
        | "action_failed"
        | "observation_failed"
        | "validation_failed"
        | "error";
    error?: string;
    lastObservation?: string;
    completedActionsSummary: string[];
}

/**
 * Orchestrates batched task execution:
 * 1. Generates a batch.
 * 2. Validates each action before execution.
 * 3. Executes actions.
 * 4. Observes desktop before requesting next batch.
 * 5. Continues until task completion, cancellation, approval requirement, or error.
 */
export async function orchestrateTaskBatches(
    initialInput: TaskPlanRequestInput,
    handlers: TaskBatchExecutionHandlers,
    options?: TaskBatchOrchestratorOptions,
): Promise<TaskBatchOrchestrationResult> {
    const maxBatches = options?.maxBatches ?? PLAN_CHUNK_MAX_COUNT;
    const maxTotalSteps = options?.maxTotalSteps ?? PLAN_MAX_TOTAL_STEPS;

    let batchesExecuted = 0;
    let totalActionsExecuted = 0;
    const completedActionsSummary: string[] = [];
    let latestObservation: string | undefined;
    const remainingObjective = initialInput.userRequest;

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

        const currentBatchInput =
            batchesExecuted === 0
                ? initialInput
                : buildNextPlanningBatchInput(initialInput, {
                      remainingObjective,
                      completedActionsSummary,
                      latestObservation,
                  });

        const planResult = await handlers.planBatch(currentBatchInput);
        if (!planResult.ok || !planResult.steps.length) {
            return {
                completed: false,
                batchesExecuted,
                totalActionsExecuted,
                stoppedReason: "error",
                error: "Planning batch failed or returned no steps",
                completedActionsSummary,
                lastObservation: latestObservation,
            };
        }

        for (const step of planResult.steps) {
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

            const actionResult = await handlers.executeAction(step.action);
            if (!actionResult.ok) {
                return {
                    completed: false,
                    batchesExecuted,
                    totalActionsExecuted,
                    stoppedReason: "action_failed",
                    error:
                        actionResult.error ??
                        actionResult.message ??
                        "Action execution failed",
                    completedActionsSummary,
                    lastObservation: latestObservation,
                };
            }

            totalActionsExecuted++;
            const actionDesc =
                (step.action as { description?: string })?.description ??
                step.action.kind;
            completedActionsSummary.push(actionDesc);

            const obs = await handlers.observeDesktop();
            if (!obs.ok || obs.stale) {
                return {
                    completed: false,
                    batchesExecuted,
                    totalActionsExecuted,
                    stoppedReason: "observation_failed",
                    error: obs.stale
                        ? "Observation is stale; refusing to continue blindly"
                        : "Desktop observation failed",
                    completedActionsSummary,
                    lastObservation: latestObservation,
                };
            }
            latestObservation = obs.observation;
        }

        batchesExecuted++;
        handlers.onBatchComplete?.(batchesExecuted, planResult);

        const state: TaskBatchExecutionState = {
            remainingObjective,
            completedActionsSummary,
            latestObservation,
        };

        if (handlers.isTaskComplete(state)) {
            return {
                completed: true,
                batchesExecuted,
                totalActionsExecuted,
                stoppedReason: "completed",
                completedActionsSummary,
                lastObservation: latestObservation,
            };
        }
    }

    return {
        completed: false,
        batchesExecuted,
        totalActionsExecuted,
        stoppedReason: totalActionsExecuted >= maxTotalSteps ? "error" : "completed",
        error:
            totalActionsExecuted >= maxTotalSteps
                ? `Exceeded max total steps (${maxTotalSteps})`
                : undefined,
        completedActionsSummary,
        lastObservation: latestObservation,
    };
}
