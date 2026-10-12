import { OctagonX, RotateCcw } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { actions, useAppState } from "@/store/app-store";
import { Pill } from "./status-badge";
import { toast } from "sonner";

export function AppHeader() {
  const worker = useAppState((s) => s.settings.workerSimulation);
  const estop = useAppState((s) => s.emergencyStop);
  return (
    <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b bg-background/90 px-3 backdrop-blur">
      <SidebarTrigger />
      <div className="flex items-center gap-2">
        <Pill tone="warning">DEMO MODE · simulated worker</Pill>
        <Pill tone={worker === "connected" ? "success" : "destructive"}>worker: {worker === "connected" ? "mock connected" : "disconnected"}</Pill>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {estop ? (
          <Button size="sm" variant="outline" onClick={() => { actions.resetEmergencyStop(); toast.success("Emergency stop reset"); }}>
            <RotateCcw className="h-4 w-4" /> Reset E-Stop
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="destructive"
          className="font-mono uppercase tracking-wide"
          disabled={estop}
          onClick={() => { actions.emergencyStop(); toast.error("Emergency stop engaged — all tasks halted"); }}
        >
          <OctagonX className="h-4 w-4" /> {estop ? "Stopped" : "Emergency Stop"}
        </Button>
      </div>
    </header>
  );
}
