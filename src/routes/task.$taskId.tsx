import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Circle, Loader2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { isActive } from "@/lib/tasks/state-machine";
import { fmtDateTime, fmtDuration } from "@/lib/format";
import { CurrentTask } from "@/components/current-task";
import { ScreenshotPanel } from "@/components/screenshot-panel";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Panel, PageHeader, EmptyState } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTicker } from "@/hooks/use-ticker";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/task/$taskId")({
  head: () => pageMeta("Task details", "Plan, steps, screenshots, errors and verification for one DesktopPilot task."),
  component: TaskDetail,
});

function TaskDetail() {
  const { taskId } = Route.useParams();
  const hydrated = useAppState((s) => s.hydrated);
  const task = useAppState((s) => s.tasks.find((t) => t.id === taskId));
  const activity = useAppState((s) => s.activity);
  const navigate = useNavigate();
  useTicker(Boolean(task && isActive(task.status)));

  if (!hydrated)
    return (
      <div className="mx-auto max-w-7xl space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  if (!task)
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState title="Task not found" hint="It may have been deleted. Go back to the task list." />
        <div className="mt-4 text-center">
          <Button asChild variant="secondary"><Link to="/tasks">All tasks</Link></Button>
        </div>
      </div>
    );

  const events = activity.filter((a) => a.taskId === task.id);
  const problems = events.filter((e) => e.kind === "error" || e.kind === "warning");
  const v = task.verification;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Task details"
        description={`Created ${fmtDateTime(task.createdAt)} · running time ${fmtDuration(task.startedAt, task.endedAt)}`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" asChild>
              <Link to="/tasks"><ArrowLeft className="h-4 w-4" /> All tasks</Link>
            </Button>
            {task.status === "failed" || task.status === "cancelled" ? (
              <Button
                size="sm"
                onClick={() => {
                  const r = actions.retry(task.id);
                  if (!r.ok) {
                    toast.error(r.issues[0]);
                    return;
                  }
                  navigate({ to: "/task/$taskId", params: { taskId: r.id } });
                }}
              >
                <RotateCw className="h-4 w-4" /> Retry
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <CurrentTask task={task} />
          {task.context ? (
            <Panel title="Project context">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.context}</p>
            </Panel>
          ) : null}
          <Panel title={`Execution plan (${task.steps.length})`}>
            {task.steps.length ? (
              <ol className="space-y-1.5">
                {task.steps.map((s, i) => {
                  const state = s.done ? "done" : i === task.currentStep && isActive(task.status) ? "current" : "pending";
                  return (
                    <li
                      key={s.id}
                      className={cn(
                        "flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm",
                        state === "current" && "border-primary/60 bg-primary/5",
                      )}
                    >
                      {state === "done" ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      ) : state === "current" ? (
                        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className={state === "pending" ? "text-muted-foreground" : ""}>
                          {i + 1}. {s.action.description}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {s.action.kind}
                          {s.action.keys ? ` · ${String(s.action.keys)}` : ""}
                          {s.action.text ? ` · “${s.action.text.slice(0, 60)}”` : ""}
                          {s.verification ? ` · check: ${s.verification.kind}` : ""}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState title="No plan yet" hint="The plan appears here once the AI has made it." />
            )}
          </Panel>
          <Panel title="Verification & summary">
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                {v?.status === "passed" ? (
                  <Check className="h-4 w-4 text-success" />
                ) : v?.status === "failed" ? (
                  <X className="h-4 w-4 text-destructive" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                {v?.status === "passed"
                  ? "Verified"
                  : v?.status === "failed"
                    ? "Verification failed"
                    : v?.status === "unverified"
                      ? "Could not be verified — not counted as a success"
                      : "Not verified yet"}
              </p>
              {v?.reason ? <p className="text-xs text-muted-foreground">{v.reason}</p> : null}
              {task.summary ? <p className="text-xs">{task.summary}</p> : null}
              <p className="font-mono text-[10px] text-muted-foreground">
                retries used {task.retries}/{task.maxRetries ?? 2} · plan changes {task.replans ?? 0}/3
              </p>
            </div>
          </Panel>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <ScreenshotPanel task={task} />
          <Panel title={`Errors & retries (${problems.length})`}>
            {problems.length ? (
              <ActivityTimeline events={problems} limit={20} />
            ) : (
              <EmptyState title="No errors" hint="Problems and retries show up here." />
            )}
          </Panel>
          <Panel title="Action history">
            <div className="max-h-[480px] overflow-y-auto pr-1">
              <ActivityTimeline events={events} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
