import { Check, Pause, Play, Square, X } from "lucide-react";
import { toast } from "sonner";
import type { Task } from "@/lib/types";
import { fmtDuration } from "@/lib/format";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Panel, EmptyState } from "./panel";
import { LocalThinkingNote } from "./ai-routing";
import { TaskStatusBadge, SimulatedTag, RealTag } from "./status-badge";

export function CurrentTask({ task }: { task?: Task | undefined }) {
  const providers = useAppState((s) => s.providers);
  const profiles = useAppState((s) => s.profiles);
  const targets = useAppState((s) => s.targets);
  const real = useAppState((s) => s.settings.workerMode === "real_local");
  const confirmed = useAppState((s) => s.realActionsConfirmed);
  if (!task)
    return (
      <Panel title="Current task">
        <EmptyState title="No task selected" hint="Start a task to see live status here." />
      </Panel>
    );

  const s = task.status;
  const step = task.steps[task.currentStep];
  const canPause = s === "queued" || s === "planning" || s === "running";
  const canCancel = canPause || s === "paused" || s === "waiting_for_approval";
  const name = <T extends { id: string }>(list: T[], id: string, k: keyof T) =>
    (list.find((x) => x.id === id)?.[k] as string) ?? `${id} (missing)`;

  return (
    <Panel title="Current task" actions={<TaskStatusBadge status={s} />}>
      <p className="text-sm">{task.description}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px]">
        <Meta k="provider" v={name(providers, task.providerId, "displayName")} />
        <Meta k="profile" v={name(profiles, task.profileId, "name")} />
        <Meta k="target" v={name(targets, task.targetId, "displayName")} />
      </dl>

      <div className="mt-4 space-y-1.5">
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>
            {task.steps.length
              ? `step ${Math.min(task.currentStep + 1, task.steps.length)}/${task.steps.length}`
              : "awaiting plan"}
          </span>
          <span>
            {task.progress}% · {fmtDuration(task.startedAt, task.endedAt)}
          </span>
        </div>
        <Progress value={task.progress} />
        {step && s !== "completed" ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            {real ? <RealTag /> : <SimulatedTag />} {step.action.description}
          </p>
        ) : null}
        {task.lastCheck ? (
          <p
            className={`text-xs ${
              task.lastCheck.verdict === "ok"
                ? "text-success"
                : task.lastCheck.verdict === "off_track"
                  ? "text-warning"
                  : "text-muted-foreground"
            }`}
          >
            {task.lastCheck.verdict === "ok"
              ? "Looks right"
              : task.lastCheck.verdict === "off_track"
                ? "Unexpected screen — adjusting plan"
                : "Could not tell"}
            {task.lastCheck.simulated ? " (simulated)" : ""}: {task.lastCheck.reason}
            {task.replans ? ` · plan adjusted ${task.replans}×` : ""}
          </p>
        ) : null}
      </div>

      {s === "waiting_for_approval" && step ? (
        <div className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm font-medium text-warning">
            {real && !confirmed
              ? "Confirm first REAL desktop action"
              : "Approve this plan to start"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The agent will run {task.steps.length} steps:
          </p>
          <ol className="mt-1 list-decimal pl-5 text-xs text-muted-foreground">
            {task.steps.map((x) => (
              <li key={x.id}>
                {x.action.description}
                {x.action.text ? ` — “${x.action.text}”` : ""}
              </li>
            ))}
          </ol>
          <p className="mt-1 text-xs text-muted-foreground">
            You will not be asked again during this task.{" "}
            {real ? "This will act on your real Windows desktop." : "This would be simulated only."}
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => actions.approve(task.id)}>
              <Check className="h-4 w-4" /> Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => actions.reject(task.id)}>
              <X className="h-4 w-4" /> Reject
            </Button>
          </div>
        </div>
      ) : null}

      <LocalThinkingNote />
      {task.error ? (
        <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {task.error}
        </p>
      ) : null}
      {task.summary && s === "completed" ? (
        <p className="mt-3 rounded border border-success/30 bg-success/5 p-2 text-xs">
          {task.summary}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canPause}
          onClick={() => actions.pause(task.id)}
        >
          <Pause className="h-4 w-4" /> Pause
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={s !== "paused"}
          onClick={() => {
            const i = actions.resume(task.id);
            if (i.length) toast.error(i[0]);
          }}
        >
          <Play className="h-4 w-4" /> Resume
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canCancel}
          onClick={() => actions.cancel(task.id)}
        >
          <Square className="h-4 w-4" /> Cancel
        </Button>
      </div>
    </Panel>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded border bg-background/50 px-2 py-1.5">
      <dt className="uppercase text-muted-foreground">{k}</dt>
      <dd className="truncate text-foreground">{v}</dd>
    </div>
  );
}
