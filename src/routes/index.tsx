import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Activity as ActivityIcon,
  CheckCircle2,
  Gauge,
  ListTodo,
  OctagonX,
  Pause,
  Play,
  SquarePen,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { isActive } from "@/lib/tasks/state-machine";
import { computeStats, dailySeries } from "@/lib/dashboard-stats";
import { fmtDateTime } from "@/lib/format";
import { CurrentTask } from "@/components/current-task";
import { ScreenshotPanel } from "@/components/screenshot-panel";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Panel, PageHeader, EmptyState } from "@/components/panel";
import { TaskStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useTicker } from "@/hooks/use-ticker";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () =>
    pageMeta("Dashboard", "Overview of DesktopPilot agent activity, live execution and task results."),
  component: Dashboard,
});

const chartConfig = {
  completed: { label: "Completed", color: "var(--success)" },
  failed: { label: "Failed", color: "var(--destructive)" },
  cancelled: { label: "Cancelled", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

function Dashboard() {
  const hydrated = useAppState((s) => s.hydrated);
  const tasks = useAppState((s) => s.tasks);
  const activity = useAppState((s) => s.activity);
  const estop = useAppState((s) => s.emergencyStop);
  const real = useAppState((s) => s.settings.workerMode === "real_local");
  const providers = useAppState((s) => s.providers);
  const targets = useAppState((s) => s.targets);
  const navigate = useNavigate();

  const active = tasks.find((t) => isActive(t.status));
  const current = active ?? tasks.find((t) => t.status !== "draft");
  useTicker(Boolean(active));
  const stats = computeStats(tasks);
  const series = dailySeries(tasks);
  const recent = tasks.filter((t) => t.status !== "draft").slice(0, 6);
  const nameOf = (list: { id: string; displayName: string }[], id: string) =>
    list.find((x) => x.id === id)?.displayName ?? id;

  const pauseAgent = () => {
    const running = tasks.filter((t) => ["queued", "planning", "running"].includes(t.status));
    if (!running.length) {
      toast.info("Nothing is running right now.");
      return;
    }
    running.forEach((t) => actions.pause(t.id));
    toast.success("Agent paused");
  };
  const resumeAgent = () => {
    const paused = tasks.filter((t) => t.status === "paused");
    if (!paused.length) {
      toast.info("Nothing is paused.");
      return;
    }
    const issue = paused.map((t) => actions.resume(t.id)).flat()[0];
    if (issue) toast.error(issue);
    else toast.success("Agent resumed");
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Dashboard"
        description={
          real
            ? "Agent control center. REAL LOCAL mode — approved tasks act on your Windows desktop."
            : "Agent control center. DEMO mode — every action shown here is simulated."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild>
              <Link to="/prompt">
                <SquarePen className="h-4 w-4" /> New Task
              </Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={pauseAgent}>
              <Pause className="h-4 w-4" /> Pause Agent
            </Button>
            <Button size="sm" variant="secondary" onClick={resumeAgent} disabled={estop}>
              <Play className="h-4 w-4" /> Resume Agent
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={estop}
              onClick={() => {
                actions.emergencyStop();
                toast.error("Emergency stop engaged — all tasks halted");
              }}
            >
              <OctagonX className="h-4 w-4" /> Emergency Stop
            </Button>
          </div>
        }
      />

      {estop ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>Emergency stop is engaged. All tasks were halted and new tasks are blocked.</span>
          <Button size="sm" variant="outline" onClick={() => actions.resetEmergencyStop()}>
            Reset
          </Button>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Total tasks" value={stats.total} icon={ListTodo} loading={!hydrated} />
        <Stat label="Running" value={stats.running} icon={ActivityIcon} tone="info" loading={!hydrated} />
        <Stat label="Completed" value={stats.completed} icon={CheckCircle2} tone="success" loading={!hydrated} hint="verified" />
        <Stat label="Failed" value={stats.failed} icon={XCircle} tone="destructive" loading={!hydrated} />
        <Stat
          label="Success rate"
          value={stats.successRate === null ? "—" : `${stats.successRate}%`}
          icon={Gauge}
          tone="primary"
          loading={!hydrated}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <CurrentTask task={current} />
          <Panel
            title="Recent tasks"
            actions={
              <Link to="/tasks" className="text-xs text-primary hover:underline">
                View all
              </Link>
            }
          >
            {!hydrated ? (
              <div className="space-y-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : recent.length ? (
              <ul className="divide-y">
                {recent.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => navigate({ to: "/task/$taskId", params: { taskId: t.id } })}
                      className="flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-accent/40"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{t.description}</p>
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {nameOf(providers, t.providerId)} · {nameOf(targets, t.targetId)} ·{" "}
                          {fmtDateTime(t.startedAt ?? t.createdAt)}
                        </p>
                        <Progress value={t.progress} className="mt-1.5 h-1" />
                      </div>
                      <TaskStatusBadge status={t.status} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No tasks yet" hint="Press New Task to write your first prompt." />
            )}
          </Panel>
          <Panel title="Task results · last 7 days">
            {stats.total ? (
              <ChartContainer config={chartConfig} className="h-52 w-full">
                <BarChart data={series}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={24} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="completed" stackId="a" fill="var(--color-completed)" />
                  <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" />
                  <Bar dataKey="cancelled" stackId="a" fill="var(--color-cancelled)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyState title="No results yet" hint="Charts appear after your first task finishes." />
            )}
          </Panel>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <ScreenshotPanel task={current} />
          <Panel
            title="Agent activity"
            actions={
              <Link to="/activity" className="text-xs text-primary hover:underline">
                Full log
              </Link>
            }
          >
            <div className="max-h-[480px] overflow-y-auto pr-1">
              <ActivityTimeline events={activity} limit={40} showTask />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

const TONE = {
  default: "text-foreground",
  info: "text-info",
  success: "text-success",
  destructive: "text-destructive",
  primary: "text-primary",
} as const;

function Stat({
  label,
  value,
  icon: Icon,
  tone = "default",
  loading,
  hint,
}: {
  label: string;
  value: number | string;
  icon: typeof ListTodo;
  tone?: keyof typeof TONE;
  loading?: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon className={cn("h-4 w-4", TONE[tone])} />
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-12" />
      ) : (
        <p className={cn("mt-1 text-2xl font-semibold tabular-nums", TONE[tone])}>{value}</p>
      )}
      {hint ? <p className="font-mono text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
