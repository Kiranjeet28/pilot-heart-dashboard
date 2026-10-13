import { Play, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Task } from "@/lib/types";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { isActive } from "@/lib/tasks/state-machine";
import { actions } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "./panel";
import { TaskStatusBadge } from "./status-badge";

export function TaskHistory({
  tasks,
  limit,
  onSelect,
  selectedId,
}: {
  tasks: Task[];
  limit?: number;
  onSelect?: (id: string) => void;
  selectedId?: string | undefined;
}) {
  const list = limit ? tasks.slice(0, limit) : tasks;
  if (!list.length)
    return <EmptyState title="No tasks yet" hint="Create a task in the composer to get started." />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden md:table-cell">Created</TableHead>
          <TableHead className="hidden md:table-cell">Duration</TableHead>
          <TableHead className="w-24 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {list.map((t) => (
          <TableRow
            key={t.id}
            data-state={selectedId === t.id ? "selected" : undefined}
            className={onSelect ? "cursor-pointer" : undefined}
            onClick={() => onSelect?.(t.id)}
          >
            <TableCell className="max-w-[320px]">
              <p className="truncate text-sm">{t.description}</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {t.providerId} · {t.profileId} · {t.targetId}
              </p>
            </TableCell>
            <TableCell>
              <TaskStatusBadge status={t.status} />
            </TableCell>
            <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
              {fmtDateTime(t.createdAt)}
            </TableCell>
            <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
              {fmtDuration(t.startedAt, t.endedAt)}
            </TableCell>
            <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
              {t.status === "draft" ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Start draft"
                  onClick={() => {
                    const i = actions.start(t.id);
                    if (i.length) toast.error(i[0]);
                  }}
                >
                  <Play className="h-4 w-4" />
                </Button>
              ) : null}
              {t.status === "failed" || t.status === "cancelled" ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Retry task"
                  onClick={() => {
                    const r = actions.retry(t.id);
                    if (!r.ok) toast.error(r.issues[0]);
                    else toast.success("Retry started");
                  }}
                >
                  <RotateCw className="h-4 w-4" />
                </Button>
              ) : null}
              {!isActive(t.status) ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Delete task"
                  onClick={() => actions.deleteTask(t.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
