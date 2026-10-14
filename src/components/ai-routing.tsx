import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  aiStatus,
  checkLocalHealth,
  isLoopbackUrl,
  retryGeminiNow,
  runLocalDiagnostics,
  DEFAULT_LOCAL_BASE_URL,
  type AiMode,
  type DiagnosticsReport,
} from "@/lib/ai/aiProvider";
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
    <p className="mt-2 animate-pulse text-xs text-info">
      Local model is thinking (slow on CPU)... Local model: {s.localTokens} tokens generated
    </p>
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
  const [diag, setDiag] = useState<DiagnosticsReport | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const cooling = s.geminiDownUntil > Date.now();

  async function diagnose() {
    setDiagRunning(true);
    setDiag(null);
    setDiag(await runLocalDiagnostics());
    setDiagRunning(false);
  }

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
                const v = url.trim() || DEFAULT_LOCAL_BASE_URL;
                if (isLoopbackUrl(v)) actions.updateSettings({ localBaseUrl: v.replace(/\/+$/, "") });
                else {
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
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={diagnose} disabled={diagRunning}>
            {diagRunning ? "Running…" : "Run diagnostics"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!cooling || settings.aiMode === "local"}
            onClick={() => {
              retryGeminiNow();
              toast.success("Gemini will be tried first on the next request");
            }}
          >
            Retry Gemini now
          </Button>
        </div>
        {diag ? (
          <div className="rounded border bg-background/50 p-2 font-mono text-[11px]">
            <p>
              Health: {diag.health.ok ? "OK" : "failed"} · {diag.health.latencyMs} ms — {diag.health.message}
            </p>
            {diag.chat ? (
              <p>
                Test chat: {diag.chat.ok ? `"${diag.chat.reply}"` : "failed"} · {(diag.chat.latencyMs / 1000).toFixed(1)} s ·{" "}
                {diag.chat.tokens} tokens · {diag.chat.tokensPerSec} tokens/s
              </p>
            ) : null}
            <p className={diag.failure ? "text-destructive" : "text-success"}>
              {diag.failure ? `Problem: ${diag.failure.replace(/_/g, " ")}. ` : ""}
              {diag.hint}
            </p>
          </div>
        ) : null}
        {s.log.length ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Recent AI requests</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {s.log.slice(0, 10).map((e) => (
                <li key={e.at + e.provider} className={e.ok ? "" : "text-destructive"}>
                  {new Date(e.at).toLocaleTimeString()} · {e.provider}
                  {e.latencyMs !== undefined ? ` · ${(e.latencyMs / 1000).toFixed(1)} s` : ""}
                  {e.outputTokens !== undefined ? ` · ${e.outputTokens} tokens` : ""}
                  {e.tokensPerSec !== undefined ? ` · ${e.tokensPerSec} tok/s` : ""} · {e.note.slice(0, 120)}
                  {e.fallbackReason ? ` · fallback: ${e.fallbackReason.slice(0, 80)}` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
