import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, isActive } from "@/lib/tasks/state-machine";
import { TaskHistory } from "@/components/task-history";
import { CurrentTask } from "@/components/current-task";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Panel, PageHeader } from "@/components/panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTicker } from "@/hooks/use-ticker";

export const Route = createFileRoute("/tasks")({
  head: () =>
    pageMeta("Tasks", "Task history with status, duration, activity and final summaries."),
  component: TasksPage,
});

function TasksPage() {
  const tasks = useAppState((s) => s.tasks);
  const activity = useAppState((s) => s.activity);
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [selectedId, setSelectedId] = useState<string>();
  const list = filter === "all" ? tasks : tasks.filter((t) => t.status === filter);
  const selected = tasks.find((t) => t.id === selectedId) ?? list[0];
  useTicker(selected && isActive(selected.status));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Tasks"
        description="Every task with its configuration, status and outcome. Credentials are never stored here."
        actions={
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Panel title={`History (${list.length})`} className="lg:col-span-3">
          <TaskHistory tasks={list} onSelect={setSelectedId} selectedId={selected?.id} />
        </Panel>
        <div className="space-y-4 lg:col-span-2">
          <CurrentTask task={selected} />
          {selected ? (
            <Panel title="Task activity">
              <div className="max-h-96 overflow-y-auto">
                <ActivityTimeline events={activity.filter((a) => a.taskId === selected.id)} />
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
