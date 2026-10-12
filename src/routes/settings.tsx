import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { actions, useAppState, worker } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Panel, PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-badge";

export const Route = createFileRoute("/settings")({
  head: () => pageMeta("Settings", "Demo mode, mock worker simulation and safety controls."),
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useAppState((s) => s.settings);
  const estop = useAppState((s) => s.emergencyStop);
  const [checking, setChecking] = useState(false);

  async function health() {
    setChecking(true);
    const h = await worker.healthCheck();
    setChecking(false);
    if (h.ok) toast.success(`${h.message} (${h.latencyMs} ms, simulated)`);
    else toast.error(`${h.message} — try reconnecting the mock worker`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Settings" description="Control the demo environment and safety state." />
      <Panel title="Mode">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Demo mode</p>
            <p className="text-xs text-muted-foreground">Locked on. A real local Windows worker is not available in this milestone.</p>
          </div>
          <Pill tone="warning">DEMO · {worker.mode}</Pill>
        </div>
      </Panel>
      <Panel title="Mock worker">
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <Label htmlFor="conn" className="flex flex-col items-start gap-1">
              <span>Simulate worker connected</span>
              <span className="text-xs font-normal text-muted-foreground">Turn off to test the disconnected state.</span>
            </Label>
            <Switch id="conn" checked={settings.workerSimulation === "connected"} onCheckedChange={(c) => actions.updateSettings({ workerSimulation: c ? "connected" : "disconnected" })} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span>Simulated action failure rate</span><span className="font-mono text-xs">{Math.round(settings.failureRate * 100)}%</span></div>
            <Slider min={0} max={50} step={5} value={[Math.round(settings.failureRate * 100)]} onValueChange={([v = 0]) => actions.updateSettings({ failureRate: v / 100 })} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-sm"><span>Step delay</span><span className="font-mono text-xs">{settings.stepDelayMs} ms</span></div>
            <Slider min={300} max={4000} step={100} value={[settings.stepDelayMs]} onValueChange={([v = 1200]) => actions.updateSettings({ stepDelayMs: v })} />
          </div>
          <Button variant="outline" onClick={health} disabled={checking}>{checking ? "Checking…" : "Run health check"}</Button>
        </div>
      </Panel>
      <Panel title="Safety">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Emergency stop</p>
            <p className="text-xs text-muted-foreground">{estop ? "Engaged — new tasks are blocked." : "Not engaged."}</p>
          </div>
          {estop ? <Button onClick={() => actions.resetEmergencyStop()}>Reset</Button> : <Button variant="destructive" onClick={() => actions.emergencyStop()}>Engage</Button>}
        </div>
      </Panel>
      <Panel title="Data">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Clears task history and restores example configuration in this browser.</p>
          <Button variant="outline" onClick={() => { if (confirm("Reset all local DesktopPilot data?")) { actions.resetAll(); toast.success("Data reset"); } }}>Reset data</Button>
        </div>
      </Panel>
    </div>
  );
}
