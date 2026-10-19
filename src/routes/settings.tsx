import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Panel, PageHeader } from "@/components/panel";
import { PairingPanel, SetupGuide } from "@/components/worker-setup";
import { AiRoutingPanel } from "@/components/ai-routing";

export const Route = createFileRoute("/settings")({
  head: () => pageMeta("Settings", "Configure AI providers, connect the local desktop worker, and manage safety."),
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useAppState((state) => state.settings);
  const stopped = useAppState((state) => state.emergencyStop);
  return <div className="mx-auto max-w-3xl space-y-4">
    <PageHeader title="Settings" description="Configure providers and connect the authenticated local desktop worker." />
    <AiRoutingPanel />
    <PairingPanel />
    <SetupGuide />
    <Panel title="Screen checks">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="adapt" className="flex flex-col items-start gap-1">
          <span>Check the screen after each step</span>
          <span className="text-xs font-normal text-muted-foreground">Checks use fresh worker observations. When a vision provider is unavailable, the result remains unverified instead of being treated as success.</span>
        </Label>
        <Switch id="adapt" checked={settings.adaptiveChecks} onCheckedChange={(checked) => actions.updateSettings({ adaptiveChecks: checked })} />
      </div>
    </Panel>
    <Panel title="Safety">
      <div className="flex items-center justify-between gap-4"><div><p className="text-sm font-medium">Emergency stop</p><p className="text-xs text-muted-foreground">{stopped ? "Engaged. New tasks are blocked." : "Not engaged."}</p></div>{stopped ? <Button onClick={() => actions.resetEmergencyStop()}>Reset stop</Button> : <Button variant="destructive" onClick={() => actions.emergencyStop()}>Emergency Stop</Button>}</div>
    </Panel>
    <Panel title="Browser data">
      <div className="flex items-center justify-between gap-4"><p className="text-xs text-muted-foreground">Clears task history and restores the example provider and target configuration in this browser.</p><Button variant="outline" onClick={() => { if (confirm("Reset all local DesktopPilot data?")) { actions.resetAll(); toast.success("Browser data reset"); } }}>Reset data</Button></div>
    </Panel>
  </div>;
}
