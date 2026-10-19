import type { TaskStatus } from "@/lib/types";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["planning", "paused", "cancelled", "failed"],
  planning: ["running", "paused", "cancelled", "failed"],
  running: [
    "waiting_for_approval",
    "awaiting_approval",
    "awaiting_input",
    "verifying",
    "planning",
    "paused",
    "completed",
    "unverified",
    "failed",
    "cancelled",
  ],
  waiting_for_approval: ["running", "cancelled", "failed"],
  awaiting_approval: ["running", "cancelled", "failed"],
  awaiting_input: ["running", "cancelled", "failed"],
  verifying: ["running", "completed", "unverified", "failed", "cancelled"],
  paused: ["queued", "planning", "running", "cancelled"],
  completed: [],
  unverified: [],
  failed: [],
  cancelled: [],
};

export const ACTIVE_STATUSES: TaskStatus[] = [
  "queued",
  "planning",
  "running",
  "waiting_for_approval",
  "awaiting_approval",
  "awaiting_input",
  "verifying",
  "paused",
];
export const TERMINAL_STATUSES: TaskStatus[] = ["completed", "unverified", "failed", "cancelled"];

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
  unverified: "Unverified",
  failed: "Failed",
  cancelled: "Cancelled",
};
