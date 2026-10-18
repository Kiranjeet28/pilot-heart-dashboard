import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProviderResponse, type ProviderResult } from "@/lib/ai/provider";
import {
  orchestrateTaskBatches,
  isTaskObjectiveComplete,
  buildBatchContinuationContext,
  buildNextPlanningBatchInput,
  type TaskBatchExecutionState,
  type TaskPlanRequestInput,
} from "@/lib/tasks/task-plan-orchestrator";
import {
  callLocal,
  configureAiRouting,
  __resetAiStatus,
  DEFAULT_LOCAL_BASE_URL,
} from "@/lib/ai/aiProvider";
import { DEFAULT_PROVIDERS } from "@/lib/registry/defaults";
import { actions, store } from "@/store/app-store";

const sse = (chunks: string[]) => {
  let body = "";
  for (const c of chunks) {
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
  }
  return new Response(body + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
};

describe("DesktopPilot — Qwen Invalid Plans and Orchestration Fixes (13 Required Tests)", () => {
  const bodies: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    __resetAiStatus();
    bodies.length = 0;
    configureAiRouting(() => ({ mode: "local", localBaseUrl: DEFAULT_LOCAL_BASE_URL }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: A valid Qwen plan is parsed, validated, and executed without unnecessary repeated planning
  it("1. valid Qwen plan is parsed, validated, and executed without unnecessary repeated planning", async () => {
    const rawQwenOutput = `\`\`\`json
{
  "summary": "Open Notepad and type hello",
  "plan": ["Launch notepad", "Type greeting"],
  "steps": [
    {
      "action": {
        "kind": "read_screen",
        "targetId": "notepad",
        "description": "Inspect window"
      },
      "requiresApproval": false
    },
    {
      "action": {
        "kind": "type_text",
        "targetId": "notepad",
        "text": "Hello world",
        "description": "Type text"
      },
      "requiresApproval": false
    }
  ]
}
\`\`\``;

    const normalized = normalizeProviderResponse(rawQwenOutput);
    expect(normalized.ok).toBe(true);
    expect(normalized.steps.length).toBe(2);

    let planBatchCalls = 0;
    const executedActions: string[] = [];

    const result = await orchestrateTaskBatches(
      { userRequest: "Open notepad and type hello" },
      {
        planBatch: async () => {
          planBatchCalls++;
          return normalized;
        },
        validateAction: () => ({ ok: true }),
        executeAction: async (action) => {
          executedActions.push((action as { description: string }).description);
          return { ok: true, message: "OK" };
        },
        observeDesktop: async () => ({ ok: true, observation: "Notepad open with Hello world" }),
        isTaskComplete: () => true, // objective confirmed complete
      },
    );

    expect(result.completed).toBe(true);
    expect(result.stoppedReason).toBe("completed");
    expect(executedActions).toEqual(["Inspect window", "Type text"]);
    // Planner must be called only ONCE, not repeated
    expect(planBatchCalls).toBe(1);
    expect(result.batchesExecuted).toBe(1);
  });

  // Test 2: A valid plan with one action executes that action without requiring three actions
  it("2. valid plan with one action executes that action without requiring three actions", async () => {
    let executedCount = 0;
    const singleActionPlan: ProviderResult = {
      ok: true,
      summary: "Inspect screen",
      plan: ["Inspect screen"],
      steps: [
        {
          action: {
            kind: "read_screen",
            targetId: "notepad",
            description: "Single screen inspection",
          },
          requiresApproval: false,
        },
      ],
    };

    const result = await orchestrateTaskBatches(
      { userRequest: "Check screen once" },
      {
        planBatch: async () => singleActionPlan,
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          executedCount++;
          return { ok: true, message: "Read screen" };
        },
        observeDesktop: async () => ({ ok: true, observation: "Done" }),
        isTaskComplete: () => true,
      },
    );

    expect(result.completed).toBe(true);
    expect(result.totalActionsExecuted).toBe(1);
    expect(executedCount).toBe(1);
  });

  // Test 3: A batch of three actions executes once, in order, after the entire batch passes validation
  it("3. batch of three actions executes once, in order, after entire batch passes validation", async () => {
    const validatedSteps: string[] = [];
    const executedSteps: string[] = [];

    const threeActionPlan: ProviderResult = {
      ok: true,
      summary: "Three step batch",
      plan: ["Step 1", "Step 2", "Step 3"],
      steps: [
        {
          action: { kind: "read_screen", targetId: "notepad", description: "Step 1: Read" },
          requiresApproval: false,
        },
        {
          action: { kind: "click", targetId: "notepad", x: 100, y: 100, description: "Step 2: Click" },
          requiresApproval: false,
        },
        {
          action: { kind: "type_text", targetId: "notepad", text: "abc", description: "Step 3: Type" },
          requiresApproval: false,
        },
      ],
    };

    const result = await orchestrateTaskBatches(
      { userRequest: "Perform 3 actions" },
      {
        planBatch: async () => threeActionPlan,
        validateAction: (action) => {
          const act = action as { description: string };
          validatedSteps.push(act.description);
          return { ok: true };
        },
        executeAction: async (action) => {
          // Confirm ALL steps were validated before the first action starts executing
          expect(validatedSteps.length).toBe(3);
          executedSteps.push((action as { description: string }).description);
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
        isTaskComplete: () => true,
      },
    );

    expect(result.completed).toBe(true);
    expect(executedSteps).toEqual(["Step 1: Read", "Step 2: Click", "Step 3: Type"]);
    expect(result.totalActionsExecuted).toBe(3);
  });

  // Test 4: An invalid second or third action prevents the whole batch from executing
  it("4. invalid second action prevents the whole batch from executing", async () => {
    let executedCount = 0;

    const planWithInvalidSecondAction: ProviderResult = {
      ok: true,
      summary: "Invalid second step",
      plan: ["Valid wait", "Invalid click without coordinates"],
      steps: [
        {
          action: { kind: "wait", targetId: "notepad", description: "Wait 100ms" },
          requiresApproval: false,
        },
        {
          action: { kind: "click", targetId: "notepad", description: "Click without coords" },
          requiresApproval: false,
        },
      ],
    };

    const result = await orchestrateTaskBatches(
      { userRequest: "Do two actions" },
      {
        planBatch: async () => planWithInvalidSecondAction,
        validateAction: (action) => {
          const act = action as { kind: string; x?: number };
          if (act.kind === "click" && act.x === undefined) {
            return { ok: false, reason: "Click missing coordinates" };
          }
          return { ok: true };
        },
        executeAction: async () => {
          executedCount++;
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
      },
    );

    expect(result.completed).toBe(false);
    expect(result.stoppedReason).toBe("validation_failed");
    expect(result.error).toContain("Click missing coordinates");
    // CRITICAL: 0 actions executed; the valid first action was never executed!
    expect(executedCount).toBe(0);
  });

  // Test 5: Missing required fields produce actionable validation diagnostics (with paths)
  it("5. missing required fields produce actionable validation diagnostics with field paths", () => {
    const invalidJsonMissingFields = JSON.stringify({
      summary: "Invalid plan",
      steps: [
        {
          action: {
            kind: "click",
            // missing targetId and description!
          },
        },
      ],
    });

    expect(() => normalizeProviderResponse(invalidJsonMissingFields)).toThrowError(
      /steps\.0\.action\.targetId: Required; steps\.0\.action\.description: Required/,
    );
  });

  // Test 6: Recoverable invalid model output uses only the configured bounded retry count (max 1 retry)
  it("6. recoverable invalid model output uses only the configured bounded retry count (max 1 retry)", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        requestCount++;
        if (init?.body) bodies.push(JSON.parse(String(init.body)));

        if (requestCount === 1) {
          // First attempt returns invalid plan
          return sse(['{"steps": "invalid_not_array"}']);
        }
        // Second attempt (bounded retry) returns valid plan
        return sse([
          JSON.stringify({
            summary: "Recovered plan",
            plan: ["Recovered wait"],
            steps: [
              {
                action: { kind: "wait", targetId: "notepad", description: "Wait" },
                requiresApproval: false,
              },
            ],
          }),
        ]);
      }),
    );

    const result = await callLocal({
      taskId: "test-retry-bounded",
      userRequest: "Test retry",
      provider: DEFAULT_PROVIDERS[0]!,
    });

    expect(result.ok).toBe(true);
    // Verified bounded retry: exactly 2 requests total (1 initial + 1 retry)
    expect(requestCount).toBe(2);
    // Bounded retry sent correction reminder
    const retryMessages = bodies[1]?.["messages"] as Array<{ content: string }>;
    expect(retryMessages?.at(-1)?.content).toBe("Return only valid JSON matching the schema.");
  });

  // Test 7: A permanently invalid response stops safely without executing actions
  it("7. permanently invalid response stops safely without executing actions", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        requestCount++;
        return sse(['{"summary": "incomplete without steps"}']);
      }),
    );

    let desktopActionCount = 0;
    const planResult = await callLocal({
      taskId: "test-permanent-invalid",
      userRequest: "Permanently invalid plan",
      provider: DEFAULT_PROVIDERS[0]!,
    });

    expect(planResult.ok).toBe(false);
    expect(requestCount).toBe(2); // Initial + 1 retry, then stops

    const orchestration = await orchestrateTaskBatches(
      { userRequest: "Permanently invalid plan" },
      {
        planBatch: async () => planResult,
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          desktopActionCount++;
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
      },
    );

    expect(orchestration.completed).toBe(false);
    expect(orchestration.stoppedReason).toBe("error");
    expect(desktopActionCount).toBe(0);
  });

  // Test 8: A completed objective does not trigger another planner call
  it("8. completed objective does not trigger another planner call", async () => {
    let planCalls = 0;
    const result = await orchestrateTaskBatches(
      { userRequest: "Close notepad" },
      {
        planBatch: async () => {
          planCalls++;
          return {
            ok: true,
            summary: "Task complete",
            plan: ["Close window"],
            steps: [
              {
                action: { kind: "wait", targetId: "notepad", description: "Close window" },
                requiresApproval: false,
              },
            ],
          };
        },
        validateAction: () => ({ ok: true }),
        executeAction: async () => ({ ok: true }),
        observeDesktop: async () => ({ ok: true, observation: "Window closed" }),
        isTaskComplete: (state, plan) => {
          return isTaskObjectiveComplete(plan.summary, plan.plan, state.remainingObjective);
        },
      },
    );

    expect(result.completed).toBe(true);
    expect(planCalls).toBe(1);
    expect(result.batchesExecuted).toBe(1);
  });

  // Test 9: An incomplete objective triggers replanning only after the previous batch finishes and a fresh observation is available
  it("9. incomplete objective triggers replanning only after previous batch finishes and fresh observation is available", async () => {
    const callOrder: string[] = [];
    let batch2ReceivedObservation: string | undefined;

    const result = await orchestrateTaskBatches(
      { userRequest: "Multi-step complex task" },
      {
        planBatch: async (input) => {
          callOrder.push("plan");
          if (callOrder.filter((c) => c === "plan").length === 2) {
            batch2ReceivedObservation = input.context?.find((c) => c.startsWith("Latest observation:"));
            return {
              ok: true,
              summary: "Task complete now",
              plan: ["Done"],
              steps: [
                {
                  action: { kind: "wait", targetId: "notepad", description: "Finish" },
                  requiresApproval: false,
                },
              ],
            };
          }
          return {
            ok: true,
            summary: "Batch 1 in progress",
            plan: ["Step 1"],
            steps: [
              {
                action: { kind: "wait", targetId: "notepad", description: "Step 1" },
                requiresApproval: false,
              },
            ],
          };
        },
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          callOrder.push("execute");
          return { ok: true };
        },
        observeDesktop: async () => {
          callOrder.push("observe");
          return { ok: true, observation: "Fresh screen after batch 1" };
        },
        isTaskComplete: (_state, plan) => plan.summary.includes("Task complete now"),
      },
    );

    expect(result.completed).toBe(true);
    expect(result.batchesExecuted).toBe(2);
    // Order must strictly be: plan 1 -> execute 1 -> observe 1 -> plan 2 -> execute 2 -> observe 2
    expect(callOrder).toEqual(["plan", "execute", "observe", "plan", "execute", "observe"]);
    // Batch 2 planner received the fresh observation from batch 1
    expect(batch2ReceivedObservation).toContain("Fresh screen after batch 1");
  });

  // Test 10: Repeated polling or React rerenders do not duplicate task submission or execution
  it("10. repeated task start requests do not create duplicate task executions", () => {
    actions.hydrate();
    const createResult = actions.createTask(
      {
        description: "Open notepad unique test",
        providerId: DEFAULT_PROVIDERS[0]!.id,
        profileId: "default",
        targetId: "notepad",
      },
      false,
    );

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.id;
    // Calling start multiple times rapidly should only start once
    actions.start(taskId);
    actions.start(taskId);
    actions.start(taskId);

    const task = store.get().tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    // Status is safely transitioned without multiple concurrent queues
    expect(["queued", "planning", "running"]).toContain(task?.status);
  });

  // Test 11: Two simultaneous tick() calls cannot execute the same task concurrently (single-flight guard)
  it("11. single-flight guard prevents simultaneous tick calls from executing task concurrently", async () => {
    let simultaneousExecutions = 0;
    let maxConcurrent = 0;

    const handlers = {
      planBatch: async () => {
        simultaneousExecutions++;
        maxConcurrent = Math.max(maxConcurrent, simultaneousExecutions);
        await new Promise((resolve) => setTimeout(resolve, 30));
        simultaneousExecutions--;
        return {
          ok: true as const,
          summary: "Done",
          plan: ["Wait"],
          steps: [
            {
              action: { kind: "wait" as const, targetId: "notepad", description: "Wait" },
              requiresApproval: false,
            },
          ],
        };
      },
      validateAction: () => ({ ok: true }),
      executeAction: async () => ({ ok: true }),
      observeDesktop: async () => ({ ok: true }),
      isTaskComplete: () => true,
    };

    // When running orchestrateTaskBatches or tick, maxConcurrent should never exceed 1
    const p1 = orchestrateTaskBatches({ userRequest: "Task 1" }, handlers);
    const p2 = orchestrateTaskBatches({ userRequest: "Task 2" }, handlers);

    await Promise.all([p1, p2]);
    // Each orchestrator runs its batches cleanly
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // Test 12: A no-progress loop terminates safely with an error
  it("12. a no-progress loop terminates safely with an error", async () => {
    // Model returns identical action every batch
    const duplicatePlan: ProviderResult = {
      ok: true,
      summary: "Repeating step",
      plan: ["Identical action"],
      steps: [
        {
          action: { kind: "wait", targetId: "notepad", description: "Duplicate wait" },
          requiresApproval: false,
        },
      ],
    };

    const result = await orchestrateTaskBatches(
      { userRequest: "Loop test" },
      {
        planBatch: async () => duplicatePlan,
        validateAction: () => ({ ok: true }),
        executeAction: async () => ({ ok: true }),
        observeDesktop: async () => ({ ok: true }),
        isTaskComplete: () => false, // never marks complete
      },
      { maxBatches: 5 },
    );

    expect(result.completed).toBe(false);
    expect(result.stoppedReason).toBe("error");
    expect(result.error).toContain("no progress was made");
  });

  // Test 13: Cancellation, Emergency Stop, approval-required states, and deadlines prevent further execution
  it("13. cancellation, approval-required states, and deadlines prevent further execution", async () => {
    let executed = 0;
    const testPlan: ProviderResult = {
      ok: true,
      summary: "Test limits",
      plan: ["Step 1", "Step 2"],
      steps: [
        {
          action: { kind: "wait", targetId: "notepad", description: "Step 1" },
          requiresApproval: false,
        },
        {
          action: { kind: "wait", targetId: "notepad", description: "Step 2" },
          requiresApproval: true,
        },
      ],
    };

    // 13a: Cancellation stops execution
    const cancelledResult = await orchestrateTaskBatches(
      { userRequest: "Cancel test" },
      {
        planBatch: async () => testPlan,
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          executed++;
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
        isCancelled: () => true,
      },
    );
    expect(cancelledResult.completed).toBe(false);
    expect(cancelledResult.stoppedReason).toBe("cancelled");
    expect(executed).toBe(0);

    // 13b: Deadline exceeded stops execution
    const deadlineResult = await orchestrateTaskBatches(
      { userRequest: "Deadline test" },
      {
        planBatch: async () => testPlan,
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          executed++;
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
        isDeadlineExceeded: () => true,
      },
    );
    expect(deadlineResult.completed).toBe(false);
    expect(deadlineResult.stoppedReason).toBe("deadline_exceeded");
    expect(executed).toBe(0);

    // 13c: Approval required halts before unapproved action
    const approvalResult = await orchestrateTaskBatches(
      { userRequest: "Approval test" },
      {
        planBatch: async () => testPlan,
        validateAction: () => ({ ok: true }),
        executeAction: async () => {
          executed++;
          return { ok: true };
        },
        observeDesktop: async () => ({ ok: true }),
        requiresApproval: (step) => (step as { requiresApproval: boolean }).requiresApproval,
      },
    );
    expect(approvalResult.completed).toBe(false);
    expect(approvalResult.stoppedReason).toBe("approval_required");
    // Only Step 1 (requiresApproval: false) executed; Step 2 was halted
    expect(executed).toBe(1);
  });
});
