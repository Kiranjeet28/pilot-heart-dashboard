import { describe, expect, it } from "vitest";
import {
    PLAN_CHUNK_MAX_COUNT,
    PLAN_CHUNK_MAX_OUTPUT_TOKENS,
    PLAN_MAX_TOTAL_STEPS,
    validateTaskDecomposition,
    mergeChunkPlans,
    getReadyChunks,
    isTaskObjectiveComplete,
    orchestrateTaskBatches,
} from "@/lib/tasks/task-plan-orchestrator";
import type { ProviderResult } from "@/lib/ai/provider";

describe("task plan orchestration foundation", () => {
    it("uses the configured planning limits", () => {
        expect(PLAN_CHUNK_MAX_OUTPUT_TOKENS).toBe(500);
        expect(PLAN_CHUNK_MAX_COUNT).toBe(8);
        expect(PLAN_MAX_TOTAL_STEPS).toBe(12);
    });

    it("requires the explicit leading completion marker and ignores positive or negative prose", () => {
        expect(isTaskObjectiveComplete("[complete] Notepad opened", [], "open Notepad")).toBe(true);
        expect(isTaskObjectiveComplete("Finished the task", [], "open Notepad")).toBe(false);
        expect(isTaskObjectiveComplete("Not complete; click target unavailable", [], "open Notepad")).toBe(false);
        expect(isTaskObjectiveComplete("Started [complete] only as a literal", [], "open Notepad")).toBe(false);
    });

    it("accepts valid independent chunks", () => {
        const result = validateTaskDecomposition({
            chunks: [
                {
                    id: "open_app",
                    description: "Open Notepad",
                    dependsOn: [],
                },
                {
                    id: "enter_text",
                    description: "Enter the requested text",
                    dependsOn: ["open_app"],
                },
            ],
        });

        expect(result.chunks).toHaveLength(2);
    });

    it("rejects duplicate IDs", () => {
        expect(() =>
            validateTaskDecomposition({
                chunks: [
                    { id: "task", description: "First task", dependsOn: [] },
                    { id: "task", description: "Second task", dependsOn: [] },
                ],
            }),
        ).toThrow(/duplicate ID/i);
    });

    it("rejects missing dependencies", () => {
        expect(() =>
            validateTaskDecomposition({
                chunks: [
                    {
                        id: "task",
                        description: "Do the task",
                        dependsOn: ["missing"],
                    },
                ],
            }),
        ).toThrow(/invalid dependency/i);
    });

    it("rejects dependency cycles", () => {
        expect(() =>
            validateTaskDecomposition({
                chunks: [
                    { id: "first", description: "First", dependsOn: ["second"] },
                    { id: "second", description: "Second", dependsOn: ["first"] },
                ],
            }),
        ).toThrow(/dependency cycle/i);
    });

    it("rejects too many chunks", () => {
        expect(() =>
            validateTaskDecomposition({
                chunks: Array.from(
                    { length: PLAN_CHUNK_MAX_COUNT + 1 },
                    (_, index) => ({
                        id: `task_${ index } `,
                        description: `Task ${ index } `,
                        dependsOn: [],
                    }),
                ),
            }),
        ).toThrow(/between 1 and 8 chunks/i);
    });

    it("merges chunk plans in the supplied order", () => {
        const makePlan = (description: string): ProviderResult => ({
            ok: true,
            plan: [description],
            summary: description,
            steps: [
                {
                    action: {
                        kind: "read_screen",
                        targetId: "desktop",
                        description,
                    },
                    requiresApproval: false,
                    verification: { kind: "screen_capture" },
                },
            ],
        });

        const merged = mergeChunkPlans([
            { chunkId: "first", result: makePlan("Inspect screen") },
            { chunkId: "second", result: makePlan("Verify screen") },
        ]);

        expect(merged.steps).toHaveLength(2);
        expect(merged.steps[0]?.action.description).toBe("Inspect screen");
        expect(merged.steps[1]?.action.description).toBe("Verify screen");
    });

    it("returns only chunks whose dependencies are completed", () => {
        const chunks = [
            { id: "a", description: "First", dependsOn: [] },
            { id: "b", description: "Independent", dependsOn: [] },
            { id: "c", description: "Depends on a", dependsOn: ["a"] },
        ];

        const ready = getReadyChunks(
            chunks,
            new Set<string>(),
            new Set<string>(),
        );

        expect(ready.map((chunk) => chunk.id)).toEqual(["a", "b"]);
    });

    it("makes dependent chunks ready after their dependency completes", () => {
        const chunks = [
            { id: "a", description: "First", dependsOn: [] },
            { id: "c", description: "Depends on a", dependsOn: ["a"] },
        ];

        const ready = getReadyChunks(
            chunks,
            new Set(["a"]),
            new Set(["a"]),
        );

        expect(ready.map((chunk) => chunk.id)).toEqual(["c"]);
    });

    it("rejects an entire batch if any action is invalid without executing earlier steps", async () => {
        let executedCount = 0;
        const result = await orchestrateTaskBatches(
            { userRequest: "Type and click" },
            {
                planBatch: async () => ({
                    ok: true,
                    plan: ["Step 1", "Step 2"],
                    summary: "Two steps",
                    steps: [
                        {
                            action: { kind: "wait", targetId: "desktop", description: "Wait" },
                            requiresApproval: false,
                        },
                        {
                            action: { kind: "click", targetId: "desktop", description: "Invalid click" },
                            requiresApproval: false,
                        },
                    ],
                }),
                validateAction: (action) => {
                    const act = action as { kind: string };
                    return act.kind === "click"
                        ? { ok: false, reason: "Click missing coordinates" }
                        : { ok: true };
                },
                executeAction: async () => {
                    executedCount++;
                    return { ok: true };
                },
                observeDesktop: async () => ({ ok: true, observation: "Screen ok" }),
            },
        );

        expect(result.completed).toBe(false);
        expect(result.stoppedReason).toBe("validation_failed");
        expect(result.error).toContain("Action rejected by validator: Click missing coordinates");
        expect(executedCount).toBe(0);
    });

    it("passes planResult to isTaskComplete callback and completes when verified", async () => {
        let planResultReceived: ProviderResult | undefined;
        const result = await orchestrateTaskBatches(
            { userRequest: "Complete objective" },
            {
                planBatch: async () => ({
                    ok: true,
                    plan: ["Done"],
                    summary: "Finished the task",
                    steps: [
                        {
                            action: { kind: "wait", targetId: "desktop", description: "Wait a bit" },
                            requiresApproval: false,
                        },
                    ],
                }),
                validateAction: () => ({ ok: true }),
                executeAction: async () => ({ ok: true, message: "Waited" }),
                observeDesktop: async () => ({ ok: true, observation: "Done screen" }),
                isTaskComplete: (state, planResult) => {
                    planResultReceived = planResult;
                    return planResult.summary.includes("Finished the task");
                },
            },
        );

        expect(result.completed).toBe(true);
        expect(result.stoppedReason).toBe("completed");
        expect(planResultReceived?.summary).toBe("Finished the task");
    });

    it("stops with error and completed=false when max batches are reached without completion", async () => {
        const result = await orchestrateTaskBatches(
            { userRequest: "Infinite task" },
            {
                planBatch: async () => ({
                    ok: true,
                    plan: ["Keep going"],
                    summary: "In progress",
                    steps: [
                        {
                            action: { kind: "wait", targetId: "desktop", description: "Waiting" },
                            requiresApproval: false,
                        },
                    ],
                }),
                validateAction: () => ({ ok: true }),
                executeAction: async () => ({ ok: true }),
                observeDesktop: async () => ({ ok: true, observation: "Still working" }),
                isTaskComplete: () => false,
            },
            { maxBatches: 2, maxTotalSteps: 10 },
        );

        expect(result.completed).toBe(false);
        expect(result.stoppedReason).toBe("error");
        expect(result.error).toContain("Reached max batches (2) before confirming task completion");
    });

    it("does not invent or attach an observation ID to a click", async () => {
        let executedCount = 0;
        let observationCount = 0;
        const result = await orchestrateTaskBatches(
            { userRequest: "Click button" },
            {
                planBatch: async () => ({
                    ok: true,
                    plan: ["Click target"],
                    summary: "Clicking target",
                    steps: [
                        {
                            action: { kind: "click", targetId: "desktop", description: "Click", x: 100, y: 200 },
                            requiresApproval: false,
                        },
                    ],
                }),
                validateAction: () => ({ ok: true }),
                executeAction: async () => {
                    executedCount++;
                    return { ok: true, message: "Clicked" };
                },
                observeDesktop: async () => {
                    observationCount++;
                    return { ok: true, observationId: "obs_fresh_999", observation: "Fresh screenshot" };
                },
            },
        );

        expect(result.completed).toBe(false);
        expect(result.stoppedReason).toBe("validation_failed");
        expect(result.error).toContain("no observation ID");
        expect(observationCount).toBe(0);
        expect(executedCount).toBe(0);
    });

    it("reports an empty follow-up plan as unverified instead of complete", async () => {
        let calls = 0;
        const result = await orchestrateTaskBatches(
            { userRequest: "Do the whole task" },
            {
                planBatch: async () => {
                    calls++;
                    return calls === 1
                        ? {
                            ok: true as const,
                            plan: ["Initial action"],
                            summary: "Continue",
                            steps: [{ action: { kind: "wait" as const, targetId: "desktop", description: "Wait", durationMs: 0 }, requiresApproval: false }],
                        }
                        : { ok: true as const, plan: [], summary: "No safe click available", steps: [] };
                },
                validateAction: () => ({ ok: true }),
                executeAction: async () => ({ ok: true }),
                observeDesktop: async () => ({ ok: true, observation: "Observed" }),
                isTaskComplete: () => false,
            },
        );

        expect(result.completed).toBe(false);
        expect(result.stoppedReason).toBe("unverified");
        expect(result.error).toContain("No safe click available");
    });

    it("never retries a desktop action after a failed or ambiguous response", async () => {
        let executeCount = 0;
        const result = await orchestrateTaskBatches(
            { userRequest: "Click once" },
            {
                planBatch: async () => ({
                    ok: true,
                    plan: ["Click"],
                    summary: "Click once",
                    steps: [{ action: { kind: "wait", targetId: "desktop", description: "Wait", durationMs: 0 }, requiresApproval: false }],
                }),
                validateAction: () => ({ ok: true }),
                executeAction: async () => {
                    executeCount++;
                    return { ok: false, error: "response lost", message: "Unknown outcome" };
                },
                observeDesktop: async () => ({ ok: true, observation: "Observed" }),
            },
        );

        expect(result.completed).toBe(false);
        expect(result.stoppedReason).toBe("action_failed");
        expect(executeCount).toBe(1);
    });
});
