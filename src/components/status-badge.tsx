import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/tasks/state-machine";

const TONE: Record<TaskStatus, string> = {
  draft: "border-border text-muted-foreground",
  queued: "border-info/40 text-info",
  planning: "border-info/40 text-info",
  running: "border-success/40 text-success",
  waiting_for_approval: "border-warning/50 text-warning",
  paused: "border-warning/40 text-warning",
  completed: "border-success/40 text-success",
  failed: "border-destructive/50 text-destructive",
  cancelled: "border-border text-muted-foreground",
};

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const pulsing = status === "running" || status === "planning" || status === "queued";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wide", TONE[status], className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current", pulsing && "animate-pulse")} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SimulatedTag({ className }: { className?: string }) {
  return (
    <span className={cn("rounded border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-wider text-warning", className)}>
      Simulated
    </span>
  );
}

export function Pill({ tone = "muted", children }: { tone?: "muted" | "success" | "warning" | "destructive" | "info"; children: ReactNode }) {
  const t = {
    muted: "border-border text-muted-foreground",
    success: "border-success/40 text-success",
    warning: "border-warning/40 text-warning",
    destructive: "border-destructive/50 text-destructive",
    info: "border-info/40 text-info",
  }[tone];
  return <span className={cn("inline-flex items-center rounded border px-2 py-0.5 font-mono text-[11px]", t)}>{children}</span>;
}
