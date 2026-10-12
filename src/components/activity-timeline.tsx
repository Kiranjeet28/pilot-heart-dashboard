import type { ActivityEvent } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmptyState } from "./panel";
import { SimulatedTag } from "./status-badge";

const DOT: Record<ActivityEvent["kind"], string> = {
  info: "bg-info",
  action: "bg-primary",
  result: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  approval: "bg-warning",
  safety: "bg-destructive",
};

export function ActivityTimeline({ events, limit, showTask }: { events: ActivityEvent[]; limit?: number; showTask?: boolean }) {
  const list = limit ? events.slice(0, limit) : events;
  if (!list.length) return <EmptyState title="No activity yet" hint="Events appear here as tasks run." />;
  return (
    <ol className="space-y-0">
      {list.map((e) => (
        <li key={e.id} className="relative flex gap-3 border-l border-border py-1.5 pl-4">
          <span className={cn("absolute -left-[4px] top-3 h-2 w-2 rounded-full", DOT[e.kind])} />
          <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground pt-0.5">{fmtTime(e.timestamp)}</span>
          <div className="min-w-0 flex-1">
            <p className={cn("text-sm", e.kind === "error" && "text-destructive", e.kind === "safety" && "font-medium text-destructive")}>{e.message}</p>
            <div className="mt-0.5 flex items-center gap-2">
              {e.simulated ? <SimulatedTag /> : null}
              {showTask && e.taskId ? <span className="font-mono text-[10px] text-muted-foreground">{e.taskId}</span> : null}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
