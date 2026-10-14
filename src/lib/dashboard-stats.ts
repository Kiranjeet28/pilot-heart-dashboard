import type { Task } from "@/lib/types";
import { isActive } from "@/lib/tasks/state-machine";

export interface TaskStats {
  total: number;
  running: number;
  completed: number;
  failed: number;
  /** Completed ÷ (completed + failed), 0-100; null when nothing has finished. */
  successRate: number | null;
}

/** Drafts are not counted; "completed" only exists after verification passed. */
export function computeStats(tasks: Task[]): TaskStats {
  const real = tasks.filter((t) => t.status !== "draft");
  const completed = real.filter((t) => t.status === "completed").length;
  const failed = real.filter((t) => t.status === "failed").length;
  const finished = completed + failed;
  return {
    total: real.length,
    running: real.filter((t) => isActive(t.status)).length,
    completed,
    failed,
    successRate: finished ? Math.round((completed / finished) * 100) : null,
  };
}

export interface DayPoint {
  day: string;
  completed: number;
  failed: number;
  cancelled: number;
}

/** Last `days` calendar days (local time), oldest first, bucketed by createdAt. */
export function dailySeries(tasks: Task[], days = 7, now = Date.now()): DayPoint[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const out: DayPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    const inDay = tasks.filter((t) => t.createdAt >= d.getTime() && t.createdAt < next.getTime());
    out.push({
      day: d.toLocaleDateString([], { weekday: "short" }),
      completed: inDay.filter((t) => t.status === "completed").length,
      failed: inDay.filter((t) => t.status === "failed").length,
      cancelled: inDay.filter((t) => t.status === "cancelled").length,
    });
  }
  return out;
}
