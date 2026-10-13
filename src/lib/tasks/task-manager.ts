import { canTransition, isTerminal } from "@/lib/tasks/state-machine";
import type { ActionRequest, PlannedStep, Task, TaskStatus } from "@/lib/types";

export interface TaskDraft {
  description: string;
  providerId: string;
  profileId: string;
  targetId: string;
}

export function createTask(draft: TaskDraft, id = `task_${Date.now().toString(36)}`): Task {
  return {
    id,
    description: draft.description.trim(),
    providerId: draft.providerId,
    profileId: draft.profileId,
    targetId: draft.targetId,
    status: "draft",
    createdAt: Date.now(),
    progress: 0,
    steps: [],
    currentStep: 0,
    retries: 0,
    verification: { status: "pending" },
  };
}

export function transitionTask(task: Task, nextStatus: TaskStatus): Task {
  if (!canTransition(task.status, nextStatus)) {
    throw new Error(`Invalid task transition: ${task.status} -> ${nextStatus}`);
  }
  return {
    ...task,
    status: nextStatus,
    updatedAt: Date.now(),
    ...(isTerminal(nextStatus)
      ? { endedAt: Date.now() }
      : task.endedAt === undefined
        ? {}
        : { endedAt: task.endedAt }),
  };
}

export function addPlan(task: Task, steps: PlannedStep[]): Task {
  if (!steps.length) throw new Error("A task plan must include at least one step");
  return { ...task, steps, currentStep: 0, status: "planning", progress: 0, updatedAt: Date.now() };
}

export function markCurrentAction(task: Task, action: ActionRequest): Task {
  return { ...task, currentAction: action, updatedAt: Date.now() };
}

export function recordVerification(
  task: Task,
  status: "passed" | "failed" | "unverified",
  reason?: string,
): Task {
  return {
    ...task,
    verification: {
      status,
      ...(reason === undefined ? {} : { reason }),
      checkedAt: Date.now(),
    },
    ...(status === "passed" ? { lastVerifiedResult: reason ?? "Verified" } : {}),
    updatedAt: Date.now(),
  };
}
