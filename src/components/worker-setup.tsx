import { useEffect, useState } from "react";
import { Link2, Link2Off, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Panel } from "./panel";
import { Pill } from "./status-badge";

export function WorkerModePanel() {
  const mode = useAppState((s) => s.settings.workerMode);
  return (
    <Panel title="Worker mode">
      <RadioGroup
        value={mode}
        onValueChange={(v) => {
          const err = actions.setWorkerMode(v === "real_local" ? "real_local" : "demo");
          if (err) toast.error(err);
        }}
        className="grid gap-3 sm:grid-cols-2"
      >
        <Label htmlFor="m-demo" className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-warning/60">
          <RadioGroupItem id="m-demo" value="demo" className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium">DEMO</span>
            <span className="block text-xs font-normal text-muted-foreground">Simulated worker. Nothing touches your PC.</span>
          </span>
        </Label>
        <Label htmlFor="m-real" className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-destructive/60">
          <RadioGroupItem id="m-real" value="real_local" className="mt-0.5" />
          <span>
            <span className="block text-sm font-medium">REAL LOCAL</span>
            <span className="block text-xs font-normal text-muted-foreground">Python worker on this Windows PC (127.0.0.1 only), after pairing.</span>
          </span>
        </Label>
      </RadioGroup>
    </Panel>
  );
}

export function PairingPanel() {
  const conn = useAppState((s) => s.connection);
  const port = useAppState((s) => s.settings.workerPort);
  const [code, setCode] = useState("");
  const [portText, setPortText] = useState(String(port));
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  useEffect(() => setPortText(String(port)), [port]);
  useEffect(() => {
    void import("@/lib/worker/token-store").then((m) => setPaired(!!m.readSession()));
  }, [conn]);

  const tone = conn.state === "connected" ? (conn.stopped ? "warning" : "success") : conn.state === "error" ? "destructive" : conn.state === "disconnected" ? "muted" : "info";
  const label = { connected: "Connected", disconnected: "Disconnected", pairing: "Pairing", busy: "Busy", error: "Error" }[conn.state];

  async function pair() {
    setBusy(true);
    const err = await actions.pairWorker(code);
    setBusy(false);
    setCode("");
    if (err) toast.error(err);
    else toast.success("Paired with local worker");
  }

  return (
    <Panel title="Local worker connection" actions={<Pill tone={tone}>{label}{conn.stopped ? " · stopped" : ""}</Pill>}>
      <div className="space-y-4">
        <p className="text-sm" role="status">{conn.message}</p>
        {conn.state === "connected" ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            worker v{conn.version} · screen {conn.screen ? `${conn.screen.width}×${conn.screen.height}` : "unknown"} · checked {conn.checkedAt ? new Date(conn.checkedAt).toLocaleTimeString() : "—"}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-[120px_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="wport">Port</Label>
            <Input id="wport" inputMode="numeric" className="font-mono" value={portText} onChange={(e) => setPortText(e.target.value)}
              onBlur={() => { const err = actions.setWorkerPort(Number(portText)); if (err) { toast.error(err); setPortText(String(port)); } }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pcode">Pairing code</Label>
            <Input id="pcode" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH" className="font-mono uppercase" value={code} maxLength={9} onChange={(e) => setCode(e.target.value)} />
          </div>
          <Button onClick={pair} disabled={busy || code.length < 8}><Link2 className="h-4 w-4" /> Pair</Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void actions.refreshConnection()}><RefreshCw className="h-4 w-4" /> Check connection</Button>
          {paired ? <Button variant="outline" size="sm" onClick={() => actions.unpairWorker()}><Link2Off className="h-4 w-4" /> Unpair</Button> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          The session token is kept only in this browser tab's session storage and sent in a request header. It is never shown, logged, or saved with your tasks.
        </p>
      </div>
    </Panel>
  );
}

const STEPS: { title: string; cmd?: string; note?: string }[] = [
  { title: "Install Python 3.11+ for Windows", note: "From python.org — tick “Add python.exe to PATH”." },
  { title: "Open PowerShell in the worker folder", cmd: "cd path\\to\\DesktopPilot\\worker\\visual-agent" },
  { title: "Create a virtual environment and install dependencies", cmd: "py -3 -m venv .venv\n.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt" },
  { title: "Create your config", cmd: "Copy-Item config.example.json config.json", note: "Make sure allowed_origins contains this page's address exactly." },
  { title: "Generate the local signing key (stored in Windows Credential Manager)", cmd: ".\\.venv\\Scripts\\python.exe -m desktoppilot_worker setup" },
  { title: "Start the worker", cmd: ".\\.venv\\Scripts\\python.exe -m desktoppilot_worker run --config config.json", note: "Keep the window open. It prints a one-time PAIRING CODE." },
  { title: "Pair", note: "Choose REAL LOCAL above, type the pairing code, click Pair. Your browser may ask to allow local network access — allow it for this site only." },
  { title: "Check status", cmd: "Invoke-RestMethod http://127.0.0.1:8765/health", note: "Or click “Check connection”. Connected only appears after an authenticated check succeeds." },
  { title: "Switch back to DEMO", note: "Select DEMO above at any time. Stop the worker with Ctrl+C in PowerShell." },
];

export function SetupGuide() {
  return (
    <Panel title="First-time setup (Windows)">
      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm">{s.title}</p>
              {s.cmd ? <pre className="mt-1 overflow-x-auto rounded border bg-background p-2 font-mono text-[11px]">{s.cmd}</pre> : null}
              {s.note ? <p className="mt-1 text-xs text-muted-foreground">{s.note}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-muted-foreground">
        Full instructions and troubleshooting: <span className="font-mono">worker/visual-agent/README.md</span>. Never disable browser security to make the connection work.
      </p>
    </Panel>
  );
}
