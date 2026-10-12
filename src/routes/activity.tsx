import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import type { ActivityKind } from "@/lib/types";
import { ActivityTimeline } from "@/components/activity-timeline";
import { Panel, PageHeader } from "@/components/panel";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const KINDS: ActivityKind[] = ["info", "action", "result", "warning", "error", "approval", "safety"];

export const Route = createFileRoute("/activity")({
  head: () => pageMeta("Activity", "Full activity log of agent events, approvals and safety actions."),
  component: ActivityPage,
});

function ActivityPage() {
  const activity = useAppState((s) => s.activity);
  const [kinds, setKinds] = useState<string[]>([]);
  const list = kinds.length ? activity.filter((a) => kinds.includes(a.kind)) : activity;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Activity" description="Every event across all tasks. Events tagged SIMULATED came from the mock worker." />
      <Panel
        title={`${list.length} events`}
        actions={
          <ToggleGroup type="multiple" size="sm" value={kinds} onValueChange={setKinds} className="flex-wrap">
            {KINDS.map((k) => <ToggleGroupItem key={k} value={k} className="font-mono text-[11px]">{k}</ToggleGroupItem>)}
          </ToggleGroup>
        }
      >
        <ActivityTimeline events={list} showTask />
      </Panel>
    </div>
  );
}
