import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Play, RotateCcw, Save, Search, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import { promptStore, searchPrompts, useSavedPrompts } from "@/lib/prompts";
import { fmtDateTime } from "@/lib/format";
import { Panel, PageHeader, EmptyState } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const Route = createFileRoute("/prompt")({
  head: () =>
    pageMeta(
      "Prompt Workspace",
      "Write a task in plain English or Hinglish and launch the DesktopPilot agent.",
    ),
  component: PromptWorkspace,
});

const EXAMPLES = [
  "Open VS Code, inspect my project, and implement login.",
  "Open my project, analyze errors, fix the issues, and verify the changes.",
  "Open the browser, navigate to my configured website, and inspect its functionality.",
  "Notepad kholo aur usme 'Hello from DesktopPilot' type karo.",
];

function PromptWorkspace() {
  const providers = useAppState((s) => s.providers);
  const profiles = useAppState((s) => s.profiles);
  const targets = useAppState((s) => s.targets);
  const real = useAppState((s) => s.settings.workerMode === "real_local");
  useAppState((s) => s.tasks);
  useAppState((s) => s.emergencyStop);
  useAppState((s) => s.connection);
  const saved = useSavedPrompts();
  const navigate = useNavigate();

  const [prompt, setPrompt] = useState("");
  const [context, setContext] = useState("");
  const [providerId, setProviderId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [maxMinutes, setMaxMinutes] = useState(10);
  const [maxRetries, setMaxRetries] = useState(2);
  const [issues, setIssues] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!providerId && providers.length)
      setProviderId(providers.find((p) => p.enabled)?.id ?? providers[0]!.id);
    if (!targetId && targets.length) setTargetId(targets[0]!.id);
  }, [providers, targets, providerId, targetId]);

  const providerProfiles = profiles.filter((p) => p.providerId === providerId);
  useEffect(() => {
    if (!providerProfiles.some((p) => p.id === profileId))
      setProfileId(providerProfiles[0]?.id ?? "");
  }, [providerId, profiles]); // eslint-disable-line react-hooks/exhaustive-deps

  const readiness = actions.readiness({ providerId, profileId, targetId });
  const tooLong = prompt.length + context.length > 4000;

  function validate(): string[] {
    const out: string[] = [];
    if (!prompt.trim()) out.push("Write what the agent should do.");
    if (tooLong) out.push("Prompt and context together must stay under 4000 characters.");
    return [...out, ...readiness];
  }

  function askStart() {
    const v = validate();
    setIssues(v);
    if (!v.length) setConfirming(true);
  }

  function start() {
    setConfirming(false);
    const r = actions.createTask(
      { description: prompt, context, providerId, profileId, targetId, maxMinutes, maxRetries },
      true,
    );
    if (!r.ok) return setIssues(r.issues);
    toast.success("Task started — review the plan to approve it");
    navigate({ to: "/task/$taskId", params: { taskId: r.id } });
  }

  const label = (list: { id: string; displayName?: string; name?: string }[], id: string) => {
    const x = list.find((i) => i.id === id);
    return x?.displayName ?? x?.name ?? "—";
  };
  const shown = searchPrompts(saved, query);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Prompt Workspace"
        description="Tell the agent what to do in plain English or Hinglish. You approve the full plan once before anything runs."
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <Panel title="Task prompt">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="prompt">What should the agent do?</Label>
                <Textarea
                  id="prompt"
                  rows={7}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. Open Notepad and type a shopping list"
                  className="font-mono text-sm"
                />
                <div className="flex flex-wrap gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setPrompt(ex)}
                      className="rounded-full border px-2.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="context">Project context (optional)</Label>
                <Textarea
                  id="context"
                  rows={3}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="Folder names, website address, anything the agent should know. Never paste passwords or keys."
                />
                <p
                  className={`text-right font-mono text-[10px] ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {prompt.length + context.length}/4000
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Configuration">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="AI provider">
                <Select value={providerId} onValueChange={setProviderId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.displayName}
                        {p.enabled ? "" : " (disabled)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Account profile">
                <Select
                  value={profileId}
                  onValueChange={setProfileId}
                  disabled={!providerProfiles.length}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        providerProfiles.length ? "Choose profile" : "No profile for this provider"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {providerProfiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Desktop target">
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose app" />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Execution mode">
                <div className="flex h-9 items-center gap-2 rounded-md border bg-background/50 px-3 text-sm">
                  <ShieldCheck className="h-4 w-4 text-success" /> Approve full plan once, then run
                </div>
              </Field>
              <Field label="Max execution time (minutes, 1–30)">
                <Input
                  type="number"
                  min={1}
                  max={30}
                  value={maxMinutes}
                  onChange={(e) =>
                    setMaxMinutes(Math.min(30, Math.max(1, Number(e.target.value) || 1)))
                  }
                />
              </Field>
              <Field label="Retry limit per step (0–2)">
                <Input
                  type="number"
                  min={0}
                  max={2}
                  value={maxRetries}
                  onChange={(e) =>
                    setMaxRetries(Math.min(2, Math.max(0, Number(e.target.value) || 0)))
                  }
                />
              </Field>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Add more providers, profiles and apps on their own pages. Profiles only store a
              reference name — keys and passwords are never shown here.
            </p>
          </Panel>

          {issues.length ? (
            <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" /> Fix these before starting
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={askStart}>
              <Play className="h-4 w-4" /> Start Task
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const s = promptStore.save(prompt, context);
                if (s) toast.success("Prompt saved");
                else toast.error("Write a prompt first");
              }}
            >
              <Save className="h-4 w-4" /> Save Prompt
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPrompt("");
                setContext("");
                setIssues([]);
              }}
            >
              Clear
            </Button>
          </div>
        </div>

        <div className="lg:col-span-2">
          <Panel title={`Saved prompts (${saved.length})`}>
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search prompts"
                className="pl-8"
                aria-label="Search saved prompts"
              />
            </div>
            {shown.length ? (
              <ul className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
                {shown.map((p) => (
                  <li
                    key={p.id}
                    className="rounded-md border p-2.5 transition-colors hover:border-primary/50"
                  >
                    <p className="text-sm">{p.title}</p>
                    {p.context ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {p.context}
                      </p>
                    ) : null}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {p.lastUsedAt
                          ? `used ${fmtDateTime(p.lastUsedAt)}`
                          : `saved ${fmtDateTime(p.createdAt)}`}
                      </span>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPrompt(p.prompt);
                            setContext(p.context);
                            promptStore.touch(p.id);
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" /> Reuse
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Delete prompt"
                          onClick={() => promptStore.remove(p.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title={saved.length ? "No prompts match" : "No saved prompts"}
                hint={
                  saved.length
                    ? "Try a different search."
                    : "Press Save Prompt to keep one for later."
                }
              />
            )}
          </Panel>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start this task?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p className="text-foreground">{prompt.trim()}</p>
                <p className="font-mono text-xs">
                  {label(providers, providerId)} · {label(profiles, profileId)} ·{" "}
                  {label(targets, targetId)} · {maxMinutes} min · {maxRetries} retries
                </p>
                <p>
                  {real
                    ? "REAL LOCAL mode: after you approve the plan, the agent will act on your real Windows desktop."
                    : "DEMO mode: every action will be simulated. Nothing on your PC is touched."}{" "}
                  You'll see the full plan and approve it once before anything runs.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={start}>Start Task</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
