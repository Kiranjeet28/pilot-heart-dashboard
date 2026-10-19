import { createFileRoute } from "@tanstack/react-router";
import { useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { TaskComposer } from "@/components/task-composer";
import { CurrentTask } from "@/components/current-task";
import { isActive } from "@/lib/tasks/state-machine";

export const Route = createFileRoute("/")({
  head: () => pageMeta("Main", "Run desktop tasks through your authenticated local worker."),
  component: MainPage,
});

function MainPage() {
  const tasks = useAppState((state) => state.tasks);
  const active = tasks.find((task) => isActive(task.status));
  const latest = active ?? tasks[0];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Main</h1>
        <p className="text-sm text-muted-foreground">
          Describe a task to run on the connected Windows desktop. Review and approve its plan before execution.
        </p>
      </div>
      <TaskComposer />
      {latest ? <CurrentTask task={latest} /> : null}
    </div>
  );
}
