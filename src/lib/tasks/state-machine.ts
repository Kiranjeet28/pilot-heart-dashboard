import type { TaskStatus } from "@/lib/types";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["planning", "paused", "cancelled", "failed"],
  planning: ["running", "paused", "cancelled", "failed"],
  running: ["waiting_for_approval", "awaiting_approval", "awaiting_input", "verifying", "paused", "completed", "failed", "cancelled"],
  waiting_for_approval: ["running", "cancelled", "failed"],
  awaiting_approval: ["running", "cancelled", "failed"],
  awaiting_input: ["running", "cancelled", "failed"],
  verifying: ["running", "completed", "failed", "cancelled"],
  paused: ["queued", "planning", "running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const ACTIVE_STATUSES: TaskStatus[] = ["queued", "planning", "running", "waiting_for_approval", "awaiting_approval", "awaiting_input", "verifying", "paused"];
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "failed", "cancelled"];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isActive(s: TaskStatus) {
  return ACTIVE_STATUSES.includes(s);
}

export function isTerminal(s: TaskStatus) {
  return TERMINAL_STATUSES.includes(s);
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  planning: "Planning",
  running: "Running",
  waiting_for_approval: "Waiting for approval",
  awaiting_approval: "Waiting for approval",
  awaiting_input: "Awaiting input",
  verifying: "Verifying",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
