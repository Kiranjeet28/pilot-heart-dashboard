import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { aiStatus, isLoopbackUrl, runLocalDiagnostics, DEFAULT_LOCAL_BASE_URL, type DiagnosticsReport } from "@/lib/ai/aiProvider";
import { routedProvider } from "@/lib/ai/aiProvider";
import type { Provider } from "@/lib/types";
import { actions, useAppState } from "@/store/app-store";
import { Panel } from "./panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SERVER_STATUS = aiStatus.get();
export const useAiStatus = () => useSyncExternalStore(aiStatus.subscribe, aiStatus.get, () => SERVER_STATUS);

export function LocalThinkingNote() {
  const status = useAiStatus();
  if (status.phase === "idle" && !status.localThinking) return null;
  const message = status.phase === "connecting" ? "Connecting to local model…" : status.phase === "processing_prompt" ? "Local model is processing the task…" : `Local model is generating a plan… ${status.localTokens} tokens`;
  return <p className="mt-2 animate-pulse font-mono text-xs text-info">{message}</p>;
}

type TestState = { state: "untested" | "testing" | "available" | "error"; message?: string };

export function AiRoutingPanel() {
  const settings = useAppState((state) => state.settings);
  const providers = useAppState((state) => state.providers);
  const profiles = useAppState((state) => state.profiles);
  const targets = useAppState((state) => state.targets);
  const localStatus = useAiStatus();
  const [url, setUrl] = useState(settings.localBaseUrl);
  const [localTesting, setLocalTesting] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsReport | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  function updateModel(id: string, model: string) {
    const provider = providers.find((item) => item.id === id);
    if (provider && model.trim()) actions.upsertProvider({ ...provider, model: model.trim(), connectionStatus: "configured_unverified" });
    setTests((current) => ({ ...current, [id]: { state: "untested" } }));
  }

  async function testProvider(provider: Provider) {
    if (provider.id === "qwen") {
      setLocalTesting(true);
      setTests((current) => ({ ...current, qwen: { state: "testing" } }));
      try {
        const report = await runLocalDiagnostics();
        const ok = report.health.ok && report.chat?.ok === true;
        const message = report.chat?.ok ? `Model inference succeeded in ${(report.chat.latencyMs / 1000).toFixed(1)} seconds.` : report.failure ? report.hint : report.health.message;
        setTests((current) => ({ ...current, qwen: { state: ok ? "available" : "error", message } }));
        if (ok) toast.success("Local Model is available"); else toast.error(message);
      } finally { setLocalTesting(false); }
      return;
    }
    const profile = profiles.find((item) => item.providerId === provider.id);
    const targetId = targets[0]?.id;
    if (!profile || !targetId) {
      setTests((current) => ({ ...current, [provider.id]: { state: "error", message: "Provider profile or desktop target is missing." } }));
      return;
    }
    setTests((current) => ({ ...current, [provider.id]: { state: "testing" } }));
    try {
      // A planning-only probe. The returned action is displayed as status and is never sent to the worker.
      const result = await routedProvider(provider, profile).getNextStep({
        userRequest: "For connection testing only, return one harmless read_screen observation step. Do not click, type, or launch anything.",
        targetId,
        provider,
        profile,
        modelOverride: provider.model,
        timeoutMs: 30000,
      });
      if (!result.ok) throw new Error(result.message);
      const useful = result.steps.some((item) => item.action.kind === "read_screen");
      if (!useful) throw new Error("Provider responded, but did not return the harmless observation plan.");
      setTests((current) => ({ ...current, [provider.id]: { state: "available", message: `Planning request succeeded with ${provider.model}. No desktop action was run.` } }));
      toast.success(`${provider.displayName} is available`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider test failed.";
      setTests((current) => ({ ...current, [provider.id]: { state: "error", message } }));
      toast.error(message);
    }
  }

  async function diagnose() {
    setDiagRunning(true); setDiag(null);
    try { setDiag(await runLocalDiagnostics()); } finally { setDiagRunning(false); }
  }

  function saveLocalUrl() {
    const value = url.trim() || DEFAULT_LOCAL_BASE_URL;
    if (!isLoopbackUrl(value)) {
      toast.error("Use a loopback address on this PC, like http://127.0.0.1:8081");
      setUrl(settings.localBaseUrl);
      return;
    }
    const normalized = value.replace(/\/+$/, "");
    actions.updateSettings({ localBaseUrl: normalized });
    const local = providers.find((provider) => provider.id === "qwen");
    if (local) updateModel("qwen", local.model);
  }

  const local = providers.find((provider) => provider.id === "qwen");
  const gemini = providers.find((provider) => provider.id === "gemini");
  const grok = providers.find((provider) => provider.id === "grok");
  return (
    <Panel title="AI provider settings">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">Choose Local Model, Gemini, or Grok for each task on Main. Provider requests are sent only to the selected provider. API keys stay in the server environment and are never stored in this browser.</p>
        {local ? <ProviderRow provider={local} onModel={updateModel} /> : null}
        <div className="space-y-2">
          <Label htmlFor="local-url">Local model URL</Label>
          <div className="flex gap-2"><Input id="local-url" value={url} onChange={(event) => setUrl(event.target.value)} onBlur={saveLocalUrl} /><Button variant="outline" onClick={() => local && void testProvider(local)} disabled={localTesting}>{localTesting ? "Testing…" : "Test Local Model"}</Button></div>
          <p className="text-xs text-muted-foreground">Loopback addresses only. The local model is text-only; screen verification may be reported as unverified.</p>
          {tests["qwen"]?.message ? <TestMessage status={tests["qwen"].state} message={tests["qwen"].message!} /> : localStatus.active === "offline" ? <TestMessage status="error" message="No successful local model check yet." /> : null}
        </div>
        {gemini ? <ServerProvider provider={gemini} envName="GEMINI_API_KEY" test={testProvider} testState={tests["gemini"]} onModel={updateModel} /> : null}
        {grok ? <ServerProvider provider={grok} envName="XAI_API_KEY" test={testProvider} testState={tests["grok"]} onModel={updateModel} /> : null}
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={diagnose} disabled={diagRunning}>{diagRunning ? "Checking…" : "Local model diagnostics"}</Button></div>
        {diag ? <div className="rounded border bg-background/50 p-2 font-mono text-[11px] space-y-1"><p>Health: {diag.health.ok ? "Available" : "Failed"} · {diag.health.latencyMs} ms — {diag.health.message}</p>{diag.chat ? <p>Model response: {diag.chat.ok ? "received" : "failed"} · {(diag.chat.latencyMs / 1000).toFixed(1)} s · {diag.chat.tokens} tokens</p> : null}<p className={diag.failure ? "text-destructive" : "text-success"}>{diag.hint}</p></div> : null}
      </div>
    </Panel>
  );
}

function ServerProvider({ provider, envName, test, testState, onModel }: { provider: Provider; envName: string; test: (provider: Provider) => Promise<void>; testState: TestState | undefined; onModel: (id: string, model: string) => void }) {
  const [model, setModel] = useState(provider.model);
  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{provider.displayName}</p><p className="text-xs text-muted-foreground">Server environment variable: <code className="font-mono">{envName}</code></p></div><Button size="sm" variant="outline" onClick={() => void test({ ...provider, model: model.trim() || provider.model })} disabled={testState?.state === "testing"}>{testState?.state === "testing" ? "Testing…" : `Test ${provider.displayName}`}</Button></div>
    <div className="space-y-1"><Label htmlFor={`${provider.id}-model`}>Model</Label><Input id={`${provider.id}-model`} value={model} onChange={(event) => setModel(event.target.value)} onBlur={() => onModel(provider.id, model)} /></div>
    {testState?.message ? <TestMessage status={testState.state} message={testState.message} /> : <p className="text-xs text-muted-foreground">Not tested in this session.</p>}
  </div>;
}

function ProviderRow({ provider, onModel }: { provider: Provider; onModel: (id: string, model: string) => void }) {
  const [model, setModel] = useState(provider.model);
  return <div className="space-y-2 rounded-md border p-3"><p className="text-sm font-medium">{provider.displayName}</p><div className="space-y-1"><Label htmlFor="local-model">Local model alias</Label><Input id="local-model" value={model} onChange={(event) => setModel(event.target.value)} onBlur={() => onModel(provider.id, model)} /></div><p className="text-xs text-muted-foreground">Model and loopback endpoint are used for local inference. The server route uses LOCAL_LLM_MODEL and LOCAL_LLM_BASE_URL.</p></div>;
}

function TestMessage({ status, message }: { status: TestState["state"]; message: string }) {
  return <p className={`text-xs ${status === "available" ? "text-success" : status === "error" ? "text-destructive" : "text-muted-foreground"}`} role="status">{message}</p>;
}
