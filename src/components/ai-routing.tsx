import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { aiStatus, checkLocalHealth, type AiMode } from "@/lib/ai/aiProvider";
import { actions, useAppState } from "@/store/app-store";
import { Panel } from "./panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const SERVER_STATUS = aiStatus.get();
export const useAiStatus = () =>
  useSyncExternalStore(aiStatus.subscribe, aiStatus.get, () => SERVER_STATUS);

/** Header badge: which AI is answering right now. */
export function AiProviderBadge() {
  const s = useAiStatus();
  const mode = useAppState((x) => x.settings.aiMode);
  const active = mode === "local" && s.active === "gemini" ? "local" : s.active;
  const cls =
    active === "gemini"
      ? "border-success/40 bg-success/10 text-success"
      : active === "local"
        ? "border-info/40 bg-info/10 text-info"
        : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <span className={`rounded border px-2 py-0.5 font-mono text-[11px] ${cls}`} title="AI provider">
      AI: {active === "gemini" ? "Gemini" : active === "local" ? "Local" : "Offline"}
    </span>
  );
}

/** Shown in the current task while the slow CPU model is answering. */
export function LocalThinkingNote() {
  const s = useAiStatus();
  if (!s.localThinking) return null;
  return (
    <p className="mt-2 animate-pulse text-xs text-info">Local model is thinking (slow on CPU)...</p>
  );
}

const MODES: Array<{ v: AiMode; label: string; hint: string }> = [
  { v: "auto", label: "Auto", hint: "Gemini first, local model when Gemini fails" },
  { v: "gemini", label: "Gemini only", hint: "Never use the local model" },
  { v: "local", label: "Local only", hint: "Always use the model on your PC" },
];

export function AiRoutingPanel() {
  const settings = useAppState((x) => x.settings);
  const s = useAiStatus();
  const [url, setUrl] = useState(settings.localBaseUrl);
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    const r = await checkLocalHealth(true);
    setTesting(false);
    if (r.ok) toast.success(r.message);
    else toast.error(r.message);
  }

  return (
    <Panel title="AI provider">
      <div className="space-y-4">
        <RadioGroup
          value={settings.aiMode}
          onValueChange={(v) => actions.updateSettings({ aiMode: v as AiMode })}
          className="space-y-2"
        >
          {MODES.map((m) => (
            <Label key={m.v} className="flex items-start gap-2 font-normal">
              <RadioGroupItem value={m.v} className="mt-0.5" />
              <span>
                <span className="text-sm">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
        <div className="space-y-1.5">
          <Label htmlFor="local-url">Local model address</Label>
          <div className="flex gap-2">
            <Input
              id="local-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => {
                const v = url.trim() || "http://127.0.0.1:8080";
                try {
                  const u = new URL(v);
                  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error();
                  actions.updateSettings({ localBaseUrl: v.replace(/\/+$/, "") });
                } catch {
                  toast.error("Use an address on this PC, like http://127.0.0.1:8081");
                  setUrl(settings.localBaseUrl);
                }
              }}
            />
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? "Testing…" : "Test local model"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The local model can plan tasks but can't see the screen, so screen checks are skipped while it's in use.
          </p>
        </div>
        {s.log.length ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Recent AI requests</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {s.log.slice(0, 10).map((e) => (
                <li key={e.at + e.provider} className={e.ok ? "" : "text-destructive"}>
                  {new Date(e.at).toLocaleTimeString()} · {e.provider} · {e.note.slice(0, 120)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
