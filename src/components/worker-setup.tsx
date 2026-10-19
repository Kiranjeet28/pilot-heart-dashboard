import { useEffect, useState } from "react";
import { Link2, Link2Off, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "./panel";
import { Pill } from "./status-badge";

export function PairingPanel() {
  const connection = useAppState((state) => state.connection);
  const port = useAppState((state) => state.settings.workerPort);
  const [code, setCode] = useState("");
  const [portText, setPortText] = useState(String(port));
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  useEffect(() => setPortText(String(port)), [port]);
  useEffect(() => { void import("@/lib/worker/token-store").then((module) => setPaired(!!module.readSession())); }, [connection]);
  const tone = connection.state === "connected" ? (connection.stopped ? "warning" : "success") : connection.state === "error" ? "destructive" : connection.state === "disconnected" ? "muted" : "info";
  const label = { connected: "Connected", disconnected: "Disconnected", pairing: "Pairing", busy: "Busy", error: "Error" }[connection.state];

  async function pair() {
    setBusy(true);
    const error = await actions.pairWorker(code);
    setBusy(false); setCode("");
    if (error) toast.error(error); else toast.success("Paired with the local worker");
  }

  return <Panel title="Local desktop worker" actions={<Pill tone={tone}>{label}{connection.stopped ? " · stopped" : ""}</Pill>}>
    <div className="space-y-4">
      <p className="text-sm" role="status">{connection.message}</p>
      {connection.state === "connected" ? <p className="font-mono text-[11px] text-muted-foreground">Worker v{connection.version} · screen {connection.screen ? `${connection.screen.width}×${connection.screen.height}` : "unknown"} · checked {connection.checkedAt ? new Date(connection.checkedAt).toLocaleTimeString() : "—"}</p> : null}
      <div className="grid gap-3 sm:grid-cols-[130px_1fr_auto] sm:items-end">
        <div className="space-y-1.5"><Label htmlFor="wport">Worker port</Label><Input id="wport" inputMode="numeric" className="font-mono" value={portText} onChange={(event) => setPortText(event.target.value)} onBlur={() => { const error = actions.setWorkerPort(Number(portText)); if (error) { toast.error(error); setPortText(String(port)); } }} /></div>
        <div className="space-y-1.5"><Label htmlFor="pcode">Pairing code</Label><Input id="pcode" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH" className="font-mono uppercase" value={code} maxLength={9} onChange={(event) => setCode(event.target.value)} /></div>
        <Button onClick={() => void pair()} disabled={busy || code.length < 8}><Link2 className="h-4 w-4" /> Pair</Button>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void actions.refreshConnection()}><RefreshCw className="h-4 w-4" /> Check connection</Button>{paired ? <Button variant="outline" size="sm" onClick={() => actions.unpairWorker()}><Link2Off className="h-4 w-4" /> Unpair</Button> : null}</div>
      <p className="text-xs text-muted-foreground">Only the authenticated worker connection can control the desktop. The session token stays in this browser tab’s session storage and is never stored with task history.</p>
    </div>
  </Panel>;
}

const STEPS = [
  { title: "Install Python 3.11+ for Windows", note: "From python.org; enable Add python.exe to PATH." },
  { title: "Open PowerShell in the worker folder", cmd: "cd path\\to\\DesktopPilot\\worker\\visual-agent" },
  { title: "Create a virtual environment and install dependencies", cmd: "py -3 -m venv .venv\n.\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt" },
  { title: "Create the worker config", cmd: "Copy-Item config.example.json config.json", note: "Set allowed_origins to this page’s exact address." },
  { title: "Set up the signing key", cmd: ".\\.venv\\Scripts\\python.exe -m desktoppilot_worker setup", note: "The key is stored in Windows Credential Manager." },
  { title: "Start the worker", cmd: ".\\.venv\\Scripts\\python.exe -m desktoppilot_worker run --config config.json", note: "Keep the window open and use its one-time pairing code." },
  { title: "Pair and check connection", note: "Enter the code above. Connected appears only after an authenticated check succeeds." },
];

export function SetupGuide() {
  return <Panel title="Worker setup">
    <ol className="space-y-3">{STEPS.map((step, index) => <li key={step.title} className="flex gap-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]">{index + 1}</span><div className="min-w-0 flex-1"><p className="text-sm">{step.title}</p>{step.cmd ? <pre className="mt-1 overflow-x-auto rounded border bg-background p-2 font-mono text-[11px]">{step.cmd}</pre> : null}{step.note ? <p className="mt-1 text-xs text-muted-foreground">{step.note}</p> : null}</div></li>)}</ol>
    <p className="mt-4 text-xs text-muted-foreground">See <span className="font-mono">worker/visual-agent/README.md</span> for full setup and troubleshooting. Keep the worker bound to loopback and do not disable browser security.</p>
  </Panel>;
}
