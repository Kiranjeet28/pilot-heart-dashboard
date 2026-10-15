
import { describe, expect, it } from "vitest";
import {
    PLAN_CHUNK_MAX_COUNT,
    PLAN_CHUNK_MAX_OUTPUT_TOKENS,
    PLAN_MAX_TOTAL_STEPS,
    validateTaskDecomposition,
} from "@/lib/server/task-plan-orchestrator";
import { mergeChunkPlans } from "@/lib/server/task-plan-orchestrator";
import type { ProviderResult } from "@/lib/ai/provider";
describe("task plan orchestration foundation", () => {
    it("uses the configured planning limits", () => {
        expect(PLAN_CHUNK_MAX_OUTPUT_TOKENS).toBe(500);
        expect(PLAN_CHUNK_MAX_COUNT).toBe(8);
        expect(PLAN_MAX_TOTAL_STEPS).toBe(12);
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
                        id: `task_${index}`,
                        description: `Task ${index}`,
                        dependsOn: [],
                    }),
                ),
            }),
        ).toThrow(/between 1 and 8 chunks/i);
    });
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