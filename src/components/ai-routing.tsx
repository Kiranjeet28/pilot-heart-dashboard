import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  aiStatus,
  checkLocalHealth,
  isLoopbackUrl,
  runLocalDiagnostics,
  DEFAULT_LOCAL_BASE_URL,
  type DiagnosticsReport,
} from "@/lib/ai/aiProvider";
import { actions, useAppState } from "@/store/app-store";
import { Panel } from "./panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SERVER_STATUS = aiStatus.get();
export const useAiStatus = () =>
  useSyncExternalStore(aiStatus.subscribe, aiStatus.get, () => SERVER_STATUS);

/** Header badge: reflects the active local Qwen provider or offline state. */
export function AiProviderBadge() {
  const s = useAiStatus();
  const active = s.active === "offline" ? "offline" : "local";
  const cls =
    active === "local"
      ? "border-info/40 bg-info/10 text-info"
      : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <span
      className={`rounded border px-2 py-0.5 font-mono text-[11px] ${cls}`}
      title="Local Qwen planner"
    >
      AI: {active === "local" ? "Local Qwen" : "Offline"}
    </span>
  );
}

/**
 * Shown in the current task while local Qwen is planning.
 * Accurately distinguishes prompt processing from active token generation.
 */
export function LocalThinkingNote() {
  const s = useAiStatus();
  if (s.phase === "idle" && !s.localThinking) return null;

  const msg =
    s.phase === "connecting"
      ? "Connecting to local Qwen..."
      : s.phase === "processing_prompt"
        ? "Local Qwen is processing task prompt..."
        : `Local Qwen is generating plan... ${s.localTokens} tokens`;

  return <p className="mt-2 animate-pulse text-xs text-info font-mono">{msg}</p>;
}

export function AiRoutingPanel() {
  const settings = useAppState((x) => x.settings);
  const s = useAiStatus();
  const [url, setUrl] = useState(settings.localBaseUrl);
  const [testing, setTesting] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsReport | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

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
    if (r.ok) toast.success(`${r.message} (${r.latencyMs} ms)`);
    else toast.error(r.message);
  }

  return (
    <Panel title="AI planner providers">
      <div className="space-y-4">
        <div className="rounded border bg-muted/40 p-3 text-xs space-y-1">
          <p className="font-medium text-foreground">Choose a planner per task</p>
          <p className="text-muted-foreground">
            Select Local Qwen or Google Gemini in the task configuration. Gemini planning uses the
            server-side <code className="font-mono text-foreground">GEMINI_API_KEY</code>; the key
            is never sent to the browser. Both planners use the same action validation and approval
            rules.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="local-url">Local server address</Label>
          <div className="flex gap-2">
            <Input
              id="local-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => {
                const v = url.trim() || DEFAULT_LOCAL_BASE_URL;
                if (isLoopbackUrl(v)) {
                  actions.updateSettings({ localBaseUrl: v.replace(/\/+$/, "") });
                } else {
                  toast.error("Use a loopback address on this PC, like http://127.0.0.1:8081");
                  setUrl(settings.localBaseUrl);
                }
              }}
            />
            <Button variant="outline" onClick={test} disabled={testing}>
              {testing ? "Testing…" : "Test local model"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The local Qwen model is text-only. Screen checks are safely skipped as unverified
            without sending screenshots to external services.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={diagnose} disabled={diagRunning}>
            {diagRunning ? "Running…" : "Run diagnostics"}
          </Button>
        </div>

        {diag ? (
          <div className="rounded border bg-background/50 p-2 font-mono text-[11px] space-y-1">
            <p>
              Health: {diag.health.ok ? "OK" : "failed"} · {diag.health.latencyMs} ms —{" "}
              {diag.health.message}
            </p>
            {diag.chat ? (
              <p>
                Test chat: {diag.chat.ok ? `"${diag.chat.reply}"` : "failed"} ·{" "}
                {(diag.chat.latencyMs / 1000).toFixed(1)} s · {diag.chat.tokens} tokens ·{" "}
                {diag.chat.tokensPerSec} tokens/s
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
            <summary className="cursor-pointer text-muted-foreground font-medium">
              Recent planning requests ({s.log.length})
            </summary>
            <ul className="mt-1 space-y-1 font-mono text-[11px]">
              {s.log.slice(0, 10).map((e) => (
                <li
                  key={e.at + e.note}
                  className={`p-1.5 rounded border ${e.ok ? "bg-muted/30" : "bg-destructive/10 text-destructive"}`}
                >
                  <div className="flex justify-between">
                    <span>{new Date(e.at).toLocaleTimeString()} · local Qwen</span>
                    <span>
                      {e.latencyMs !== undefined ? `${(e.latencyMs / 1000).toFixed(1)} s` : ""}
                      {e.outputTokens !== undefined ? ` · ${e.outputTokens} tok` : ""}
                      {e.tokensPerSec !== undefined ? ` · ${e.tokensPerSec} tok/s` : ""}
                    </span>
                  </div>
                  {e.promptMs !== undefined ? (
                    <div className="text-[10px] text-muted-foreground">
                      Prompt prefill: {e.promptMs.toFixed(0)} ms ({e.promptTokens ?? 0} tokens,{" "}
                      {e.cacheTokens ?? 0} cached)
                      {e.timeToFirstTokenMs
                        ? ` · TTFT: ${(e.timeToFirstTokenMs / 1000).toFixed(1)} s`
                        : ""}
                    </div>
                  ) : null}
                  <div className="truncate text-muted-foreground">{e.note}</div>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}
