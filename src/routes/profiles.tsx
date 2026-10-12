import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import type { AccountProfile } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Panel, PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-badge";
import { RegistryTable } from "@/components/registry-table";
import { EntityFormDialog, required, slugId, type FieldDef } from "@/components/entity-form-dialog";

export const Route = createFileRoute("/profiles")({
  head: () => pageMeta("Account profiles", "Named account profiles linking providers to protected credential references."),
  component: ProfilesPage,
});

const BLANK: AccountProfile = { id: "", name: "", providerId: "", authMethod: "api_key_ref", credentialRef: "", notes: "" };

function ProfilesPage() {
  const profiles = useAppState((s) => s.profiles);
  const providers = useAppState((s) => s.providers);
  const tasks = useAppState((s) => s.tasks);
  const [editing, setEditing] = useState<{ value: AccountProfile; originalId?: string } | null>(null);

  const fields: FieldDef<AccountProfile>[] = [
    { name: "name", label: "Profile name", type: "text", placeholder: "Personal, Work…", validate: required("Name") },
    { name: "id", label: "Profile ID", type: "text", mono: true, validate: slugId(profiles.map((p) => p.id), editing?.originalId) },
    { name: "providerId", label: "Provider", type: "select", options: providers.map((p) => ({ value: p.id, label: p.displayName })), validate: (v) => (providers.some((p) => p.id === v) ? undefined : "Choose a provider") },
    { name: "authMethod", label: "Authentication", type: "select", options: [{ value: "api_key_ref", label: "API key reference" }, { value: "oauth_ref", label: "OAuth reference" }, { value: "session_ref", label: "Browser session reference" }, { value: "none", label: "None" }] },
    {
      name: "credentialRef", label: "Credential reference name", type: "text", mono: true, placeholder: "OPENAI_PERSONAL_KEY",
      hint: "The NAME of a secret held by a protected credential store (e.g. Windows Credential Manager). Never paste the secret itself.",
      validate: (v, all) => {
        const s = String(v ?? "");
        if (all.authMethod === "none") return undefined;
        if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(s)) return "Use UPPER_SNAKE_CASE (3–64 chars)";
        if (/^(sk-|AIza|sk_ant)/i.test(s)) return "This looks like a real key — enter a reference name instead";
        return undefined;
      },
    },
    { name: "notes", label: "Notes", type: "textarea" },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Account profiles" description="Profiles reference a provider and a credential by name. Secrets are never displayed or stored here." actions={<Button onClick={() => setEditing({ value: { ...BLANK, providerId: providers[0]?.id ?? "" } })}><Plus className="h-4 w-4" /> Add profile</Button>} />
      <div className="mb-4 flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        Credential resolution will happen inside the local worker at execution time. The dashboard only ever sees the reference name.
      </div>
      <Panel>
        <RegistryTable
          rows={profiles}
          emptyTitle="No profiles yet"
          columns={[
            { header: "Profile", cell: (p) => <div><p className="text-sm font-medium">{p.name}</p><p className="font-mono text-[11px] text-muted-foreground">{p.id}</p></div> },
            { header: "Provider", cell: (p) => { const pr = providers.find((x) => x.id === p.providerId); return pr ? <span className="text-sm">{pr.displayName}</span> : <Pill tone="destructive">missing provider</Pill>; } },
            { header: "Auth", className: "hidden md:table-cell", cell: (p) => <span className="font-mono text-xs text-muted-foreground">{p.authMethod}</span> },
            { header: "Credential ref", cell: (p) => (p.authMethod === "none" ? <span className="text-muted-foreground">—</span> : <span className="font-mono text-xs">{p.credentialRef} <span className="text-muted-foreground">••••</span></span>) },
          ]}
          onEdit={(p) => setEditing({ value: p, originalId: p.id })}
          onDelete={(p) => {
            if (tasks.some((t) => t.profileId === p.id && ["queued", "planning", "running", "waiting_for_approval", "paused"].includes(t.status))) { toast.error("An active task uses this profile"); return; }
            actions.deleteProfile(p.id);
          }}
        />
      </Panel>
      <EntityFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.originalId ? "Edit profile" : "Add profile"}
        fields={fields}
        initial={editing?.value ?? BLANK}
        onSubmit={(p) => { actions.upsertProfile(p, editing?.originalId); toast.success("Profile saved"); }}
      />
    </div>
  );
}
