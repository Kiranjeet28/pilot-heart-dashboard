import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Play } from "lucide-react";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "./panel";

const PROVIDER_LABELS: Record<string, string> = {
  qwen: "Local Model",
  gemini: "Gemini",
  grok: "Grok",
};
const MAIN_PROVIDER_IDS = ["qwen", "gemini", "grok"];

export function TaskComposer() {
  const providers = useAppState((state) => state.providers);
  const profiles = useAppState((state) => state.profiles);
  const targets = useAppState((state) => state.targets);
  const emergencyStop = useAppState((state) => state.emergencyStop);
  const connection = useAppState((state) => state.connection);
  useAppState((state) => state.tasks);
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState("");
  const [error, setError] = useState("");
  const submitting = useRef(false);

  const availableProviders = providers.filter((provider) => MAIN_PROVIDER_IDS.includes(provider.id));
  useEffect(() => {
    if (!availableProviders.some((provider) => provider.id === providerId)) {
      const preferred = availableProviders.find((provider) => provider.id === "gemini" && provider.enabled)
        ?? availableProviders.find((provider) => provider.id === "qwen" && provider.enabled)
        ?? availableProviders.find((provider) => provider.enabled)
        ?? availableProviders[0];
      if (preferred) setProviderId(preferred.id);
    }
  }, [availableProviders, providerId]);

  const provider = availableProviders.find((item) => item.id === providerId);
  const profile = profiles.find((item) => item.providerId === providerId);
  const targetId = targets.find((target) => target.id === "desktop")?.id ?? targets[0]?.id ?? "";
  const readiness = actions.readiness({ providerId, profileId: profile?.id ?? "", targetId });
  const connected = connection.state === "connected" && !connection.stopped;

  function submit() {
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    try {
      if (!description.trim()) {
        setError("Describe the task before running it.");
        return;
      }
      if (!provider || !profile || !targetId) {
        setError("The selected provider or desktop target is not configured. Check Settings.");
        return;
      }
      const result = actions.createTask(
        { description, providerId, profileId: profile.id, targetId },
        true,
      );
      if (!result.ok) {
        setError(result.issues[0] ?? "The task could not be started.");
        return;
      }
      setDescription("");
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Panel title="Run a task">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="task-description">Task</Label>
          <Textarea
            id="task-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe what you want your computer to do..."
            className="min-h-36 resize-y text-base"
            maxLength={4000}
            aria-describedby="task-help"
          />
          <p id="task-help" className="text-xs text-muted-foreground">
            The complete plan is shown for your approval before any desktop action runs.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="task-provider">AI model</Label>
            <Select value={providerId} onValueChange={setProviderId}>
              <SelectTrigger id="task-provider" aria-label="AI model provider">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {availableProviders.map((item) => (
                  <SelectItem key={item.id} value={item.id} disabled={!item.enabled}>
                    {PROVIDER_LABELS[item.id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={submit} disabled={!connected || emergencyStop || readiness.length > 0}>
            <Play className="h-4 w-4" /> Run Task
          </Button>
        </div>

        {!connected ? (
          <p className="text-sm text-warning" role="status">
            Worker is {connection.stopped ? "stopped" : "disconnected"}. Connect and pair it in Settings before running a task.
          </p>
        ) : null}
        {readiness.length > 0 && connected ? (
          <p className="text-sm text-warning" role="status">{readiness[0]}</p>
        ) : null}
        {error ? (
          <p className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
