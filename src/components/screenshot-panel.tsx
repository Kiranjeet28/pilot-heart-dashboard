import { MonitorOff } from "lucide-react";
import type { Task } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { useAppState } from "@/store/app-store";
import { Panel } from "./panel";
import { RealTag, SimulatedTag } from "./status-badge";

export function ScreenshotPanel({ task }: { task?: Task | undefined }) {
  const worker = useAppState((s) => s.settings.workerSimulation);
  const mode = useAppState((s) => s.settings.workerMode);
  const obs = task?.lastObservation;
  return (
    <Panel
      title="Desktop preview"
      actions={obs ? obs.simulated ? <SimulatedTag /> : <RealTag /> : null}
    >
      {obs ? (
        <figure>
          <img
            src={obs.imageDataUrl}
            alt={obs.simulated ? "Simulated desktop observation" : "Real desktop screenshot"}
            className="w-full rounded border"
          />
          <figcaption className="mt-2 font-mono text-[11px] text-muted-foreground">
            {obs.simulated
              ? `Mock observation captured ${fmtTime(obs.capturedAt)} — not a real screenshot`
              : `Real screenshot from your PC, captured ${fmtTime(obs.capturedAt)} (kept in memory only, not saved)`}
          </figcaption>
        </figure>
      ) : (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded border border-dashed text-center">
          <MonitorOff className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">No local Windows worker connected</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            {mode === "real_local"
              ? "REAL LOCAL mode: run a task or the Notepad test in Settings to capture a real screenshot."
              : worker === "connected"
                ? "Demo worker produces simulated previews once a task runs."
                : "Worker disconnected. Real screenshots require the local worker (future milestone)."}
          </p>
        </div>
      )}
    </Panel>
  );
}
