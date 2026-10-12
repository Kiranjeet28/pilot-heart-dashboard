import { MonitorOff } from "lucide-react";
import type { Task } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { useAppState } from "@/store/app-store";
import { Panel } from "./panel";
import { SimulatedTag } from "./status-badge";

export function ScreenshotPanel({ task }: { task?: Task }) {
  const worker = useAppState((s) => s.settings.workerSimulation);
  const obs = task?.lastObservation;
  return (
    <Panel title="Desktop preview" actions={obs?.simulated ? <SimulatedTag /> : null}>
      {obs ? (
        <figure>
          <img src={obs.imageDataUrl} alt="Simulated desktop observation" className="w-full rounded border" />
          <figcaption className="mt-2 font-mono text-[11px] text-muted-foreground">Mock observation captured {fmtTime(obs.capturedAt)} — not a real screenshot</figcaption>
        </figure>
      ) : (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded border border-dashed text-center">
          <MonitorOff className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">No local Windows worker connected</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            {worker === "connected" ? "Demo worker produces simulated previews once a task runs." : "Worker disconnected. Real screenshots require the local worker (future milestone)."}
          </p>
        </div>
      )}
    </Panel>
  );
}
