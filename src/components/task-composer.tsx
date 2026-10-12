import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Play, Save } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Panel } from "./panel";

export function TaskComposer() {
  const providers = useAppState((s) => s.providers);
  const profiles = useAppState((s) => s.profiles);
  const targets = useAppState((s) => s.targets);
  useAppState((s) => s.tasks); // re-evaluate readiness on task changes
  useAppState((s) => s.emergencyStop);
  useAppState((s) => s.settings);

  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    if (!providerId && providers.length) setProviderId(providers.find((p) => p.enabled)?.id ?? providers[0]!.id);
    if (!targetId && targets.length) setTargetId(targets[0]!.id);
  }, [providers, targets, providerId, targetId]);

  const providerProfiles = profiles.filter((p) => p.providerId === providerId);
  useEffect(() => {
    if (!providerProfiles.some((p) => p.id === profileId)) setProfileId(providerProfiles[0]?.id ?? "");
  }, [providerId, profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = actions.readiness({ providerId, profileId, targetId });

  function submit(start: boolean) {
    const r = actions.createTask({ description, providerId, profileId, targetId }, start);
    if (!r.ok) {
      setIssues(r.issues);
      return;
    }
    setIssues([]);
    setDescription("");
    toast.success(start ? "Task started in demo mode" : "Draft saved");
  }

  return (
    <Panel title="New task">
      <div className="space-y-3">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what DesktopPilot should do, e.g. “Open the README in VS Code and ask the assistant to summarise it.”"
          className="min-h-28 resize-y font-mono text-sm"
          maxLength={4000}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Provider">
            <Select value={providerId} onValueChange={setProviderId}>
              <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.displayName}{p.enabled ? "" : " (disabled)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Profile">
            <Select value={profileId} onValueChange={setProfileId} disabled={!providerProfiles.length}>
              <SelectTrigger><SelectValue placeholder={providerProfiles.length ? "Select profile" : "No profile for provider"} /></SelectTrigger>
              <SelectContent>
                {providerProfiles.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Desktop target">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger><SelectValue placeholder="Select target" /></SelectTrigger>
              <SelectContent>
                {targets.map((t) => <SelectItem key={t.id} value={t.id}>{t.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>

        {(issues.length ? issues : live).length ? (
          <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/5 p-2.5">
            {(issues.length ? issues : live).map((i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-warning"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{i}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[11px] text-muted-foreground">Runs against the mock worker. No real desktop actions.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => submit(false)}><Save className="h-4 w-4" /> Save draft</Button>
            <Button onClick={() => submit(true)} disabled={live.length > 0}><Play className="h-4 w-4" /> Start Task</Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
