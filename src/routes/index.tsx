import { createFileRoute, Link } from "@tanstack/react-router";
import { useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { isActive } from "@/lib/tasks/state-machine";
import { TaskComposer } from "@/components/task-composer";
import { CurrentTask } from "@/components/current-task";
import { ScreenshotPanel } from "@/components/screenshot-panel";
import { ActivityTimeline } from "@/components/activity-timeline";
import { TaskHistory } from "@/components/task-history";
import { Panel, PageHeader } from "@/components/panel";
import { useTicker } from "@/hooks/use-ticker";

export const Route = createFileRoute("/")({
  head: () => pageMeta("Dashboard", "Compose tasks, monitor progress and control the DesktopPilot agent."),
  component: Dashboard,
});

function Dashboard() {
  const tasks = useAppState((s) => s.tasks);
  const activity = useAppState((s) => s.activity);
  const estop = useAppState((s) => s.emergencyStop);
  const current = tasks.find((t) => isActive(t.status)) ?? tasks.find((t) => t.status !== "draft");
  useTicker(current && isActive(current.status));
  const currentActivity = current ? activity.filter((a) => a.taskId === current.id || a.taskId === null) : activity;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader title="Dashboard" description="Submit a task and watch the agent work. All actions in this build are simulated." />
      {estop ? (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Emergency stop is engaged. All tasks were halted and new tasks are blocked until you reset it.
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <TaskComposer />
          <CurrentTask task={current} />
          <Panel title="Recent tasks" actions={<Link to="/tasks" className="text-xs text-primary hover:underline">View all</Link>}>
            <TaskHistory tasks={tasks} limit={5} />
          </Panel>
        </div>
        <div className="space-y-4 lg:col-span-2">
          <ScreenshotPanel task={current} />
          <Panel title="Live activity" actions={<Link to="/activity" className="text-xs text-primary hover:underline">Full log</Link>}>
            <div className="max-h-[420px] overflow-y-auto pr-1">
              <ActivityTimeline events={currentActivity} limit={40} />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
