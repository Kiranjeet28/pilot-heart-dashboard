// Guided, controlled real-desktop test on an empty Notepad window.
import { useRef, useState, type MouseEvent } from "react";
import { Camera, OctagonX, Play } from "lucide-react";
import { toast } from "sonner";
import { actions, store, useAppState } from "@/store/app-store";
import type { ActionRequest } from "@/lib/types";
import type { ObservationResult } from "@/lib/worker/worker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Panel } from "./panel";
import { RealTag } from "./status-badge";

export const TEST_STRING = "DesktopPilot test 123";
const T = "notepad";

type StepState = "pending" | "running" | "ok" | "failed";
const PLAN: { label: string; build: (p: { x: number; y: number; oid: string }) => ActionRequest }[] = [
  { label: "Click the selected text area", build: ({ x, y, oid }) => ({ kind: "click", targetId: T, x, y, observationId: oid, description: `Click Notepad text area at (${x}, ${y})` }) },
  { label: `Type “${TEST_STRING}”`, build: () => ({ kind: "type_text", targetId: T, text: TEST_STRING, description: "Type harmless test string" }) },
  { label: "Select all (Ctrl+A)", build: () => ({ kind: "key_press", targetId: T, keys: "ctrl+a", description: "Select text" }) },
  { label: "Copy selection", build: () => ({ kind: "copy_selection", targetId: T, description: "Copy selected text" }) },
  { label: "Move to end, new line", build: () => ({ kind: "key_press", targetId: T, keys: "end", description: "Move caret to end" }) },
  { label: "Enter", build: () => ({ kind: "key_press", targetId: T, keys: "enter", description: "New line" }) },
  { label: "Paste (Ctrl+V)", build: () => ({ kind: "paste", targetId: T, description: "Paste copied text" }) },
  { label: "Wait 500 ms", build: () => ({ kind: "wait", targetId: T, durationMs: 500, description: "Let Notepad redraw" }) },
];

export function NotepadTestPanel() {
  const conn = useAppState((s) => s.connection);
  const confirmed = useAppState((s) => s.realActionsConfirmed);
  const estop = useAppState((s) => s.emergencyStop);
  const [opened, setOpened] = useState(false);
  const [obs, setObs] = useState<ObservationResult | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [steps, setSteps] = useState<StepState[]>(PLAN.map(() => "pending"));
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [after, setAfter] = useState<ObservationResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<null | "capture" | "run">(null);
  const abort = useRef(false);

  const ready = conn.state === "connected" && !conn.stopped && !estop;

  async function capture() {
    try {
      const o = await actions.realObserve();
      setObs(o);
      setPoint(null);
      setAfter(null);
      setReport(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Capture failed");
    }
  }

  function pick(e: MouseEvent<HTMLImageElement>) {
    if (!obs?.width || !obs.height) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * obs.width);
    const y = Math.floor(((e.clientY - r.top) / r.height) * obs.height);
    setPoint({ x: Math.min(x, obs.width - 1), y: Math.min(y, obs.height - 1) });
  }

  async function run() {
    if (!obs?.observationId || !point || !obs.width || !obs.height) return;
    if (Date.now() - obs.capturedAt > 50_000) {
      toast.error("Screenshot is older than 50 seconds. Capture again, then pick the point.");
      return;
    }
    abort.current = false;
    setRunning(true);
    setReport(null);
    setSteps(PLAN.map(() => "pending"));
    let copied: number | undefined;
    const screen = { width: obs.width, height: obs.height };
    for (let i = 0; i < PLAN.length; i++) {
      if (abort.current || store.get().emergencyStop) {
        setReport("Stopped before completion. No further actions were sent.");
        setRunning(false);
        return;
      }
      setSteps((s) => s.map((v, j) => (j === i ? "running" : v)));
      try {
        const r = await actions.runRealAction(PLAN[i]!.build({ ...point, oid: obs.observationId }), screen);
        if (!r.ok) throw new Error(r.message);
        if (r.data?.clipboardLength != null) copied = r.data.clipboardLength;
        setSteps((s) => s.map((v, j) => (j === i ? "ok" : v)));
      } catch (e) {
        setSteps((s) => s.map((v, j) => (j === i ? "failed" : v)));
        setReport(`Step ${i + 1} failed: ${e instanceof Error ? e.message : "error"}. Remaining steps were not run.`);
        setRunning(false);
        return;
      }
    }
    try {
      setAfter(await actions.realObserve());
    } catch {
      /* report below still useful */
    }
    const match = copied === TEST_STRING.length;
    setReport(
      `Typed ${TEST_STRING.length} characters, copied ${copied ?? "?"} characters (${match ? "matches" : "does NOT match — the window may have had other text or lost focus"}), then pasted. Check the screenshot below: Notepad should show “${TEST_STRING}” on two lines. DesktopPilot cannot read the screen text itself yet, so please confirm visually.`,
    );
    setRunning(false);
  }

  function stop() {
    abort.current = true;
    actions.emergencyStop();
  }

  function guarded(kind: "capture" | "run") {
    if (!confirmed) setConfirmOpen(kind);
    else void (kind === "capture" ? capture() : run());
  }

  return (
    <Panel title="Guided Notepad test" actions={<RealTag />}>
      <div className="space-y-4">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Open a <strong>new, empty</strong> Notepad window on the main screen. Don't type anything private in it.</li>
          <li>Keep Notepad visible next to this browser window, not covered by it.</li>
          <li>The test only clicks, types, copies and pastes inside the point you pick. It never saves, closes apps, or touches files.</li>
          <li>Emergency: the red Stop button, Ctrl+C in the worker window, or move the mouse into a screen corner.</li>
        </ul>

        {!ready ? <p className="rounded border border-warning/40 bg-warning/5 p-2 text-xs text-warning">Needs a connected, non-stopped local worker and no active emergency stop.</p> : null}

        <div className="flex items-center gap-2">
          <Checkbox id="np-open" checked={opened} onCheckedChange={(c) => setOpened(c === true)} />
          <Label htmlFor="np-open">1. I opened an empty Notepad window</Label>
        </div>

        <Button variant="outline" disabled={!ready || !opened || running} onClick={() => guarded("capture")}><Camera className="h-4 w-4" /> 2. Capture desktop</Button>

        {obs ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">3. Click inside Notepad's text area in this screenshot to choose where to type.</p>
            <div className="relative">
              <img src={obs.imageDataUrl} alt="Real desktop screenshot — click to pick a point" onClick={pick} className="w-full cursor-crosshair rounded border" />
              {point && obs.width && obs.height ? (
                <span className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-destructive bg-destructive/30"
                  style={{ left: `${(point.x / obs.width) * 100}%`, top: `${(point.y / obs.height) * 100}%` }} />
              ) : null}
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">screen {obs.width}×{obs.height}{point ? ` · target (${point.x}, ${point.y})` : " · no point selected"}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={!ready || !point || running} onClick={() => guarded("run")}><Play className="h-4 w-4" /> 4. Run test</Button>
          <Button variant="destructive" onClick={stop}><OctagonX className="h-4 w-4" /> Stop</Button>
        </div>

        <ol className="space-y-1">
          {PLAN.map((p, i) => (
            <li key={p.label} className="flex items-center gap-2 font-mono text-xs">
              <span className={steps[i] === "ok" ? "text-success" : steps[i] === "failed" ? "text-destructive" : steps[i] === "running" ? "text-info" : "text-muted-foreground"}>
                {steps[i] === "ok" ? "✓" : steps[i] === "failed" ? "✗" : steps[i] === "running" ? "…" : "○"}
              </span>
              {p.label}
            </li>
          ))}
        </ol>

        {report ? <p className="rounded border p-2 text-sm">{report}</p> : null}
        {after ? <img src={after.imageDataUrl} alt="Real desktop after the test" className="w-full rounded border" /> : null}
      </div>

      <AlertDialog open={!!confirmOpen} onOpenChange={(o) => !o && setConfirmOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow real desktop actions?</AlertDialogTitle>
            <AlertDialogDescription>
              DesktopPilot will capture your real screen and may click, type, copy and paste on this Windows PC through the local worker. Only allowlisted actions are permitted. This confirmation lasts until you close the tab, unpair, or switch modes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const k = confirmOpen; actions.confirmRealActions(); setConfirmOpen(null); void (k === "capture" ? capture() : run()); }}>
              Allow for this session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
