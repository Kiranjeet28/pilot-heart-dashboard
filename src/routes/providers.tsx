import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import type { Provider } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Panel, PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-badge";
import { RegistryTable } from "@/components/registry-table";
import { EntityFormDialog, required, slugId, type FieldDef } from "@/components/entity-form-dialog";

export const Route = createFileRoute("/providers")({
  head: () => pageMeta("Providers", "Configure AI providers, models and connection methods."),
  component: ProvidersPage,
});

const BLANK: Provider = {
  id: "",
  displayName: "",
  type: "custom",
  connectionMethod: "api_key",
  model: "",
  enabled: false,
  connectionStatus: "not_configured",
};
const STATUS = {
  not_configured: ["Not configured", "muted"],
  configured_unverified: ["Configured · unverified", "warning"],
  error: ["Error", "destructive"],
} as const;

function ProvidersPage() {
  const providers = useAppState((s) => s.providers);
  const profiles = useAppState((s) => s.profiles);
  const [editing, setEditing] = useState<{ value: Provider; originalId?: string } | null>(null);

  const fields: FieldDef<Provider>[] = [
    {
      name: "displayName",
      label: "Display name",
      type: "text",
      validate: required("Display name"),
    },
    {
      name: "id",
      label: "Provider ID",
      type: "text",
      mono: true,
      placeholder: "my-provider",
      validate: slugId(
        providers.map((p) => p.id),
        editing?.originalId,
      ),
    },
    {
      name: "type",
      label: "Provider type",
      type: "select",
      options: [
        { value: "openai", label: "OpenAI" },
        { value: "gemini", label: "Google Gemini" },
        { value: "anthropic", label: "Anthropic" },
        { value: "custom", label: "Custom" },
      ],
    },
    {
      name: "connectionMethod",
      label: "Connection method",
      type: "select",
      options: [
        { value: "api_key", label: "API key (via protected secret)" },
        { value: "oauth", label: "OAuth" },
        { value: "local_endpoint", label: "Local endpoint" },
        { value: "browser_session", label: "Browser session (desktop target)" },
      ],
    },
    {
      name: "model",
      label: "Model identifier",
      type: "text",
      mono: true,
      placeholder: "e.g. gpt-5",
      validate: (v, all) =>
        all.enabled && !String(v).trim() ? "Enabled providers need a model" : undefined,
    },
    { name: "enabled", label: "Enabled", type: "switch" },
  ];

  function save(p: Provider) {
    const status = p.model.trim()
      ? p.connectionStatus === "error"
        ? "error"
        : "configured_unverified"
      : "not_configured";
    actions.upsertProvider(
      { ...p, model: p.model.trim(), connectionStatus: status },
      editing?.originalId,
    );
    toast.success("Provider saved");
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Providers"
        description="Provider registry. No provider is marked connected until a real integration is implemented and verified."
        actions={
          <Button onClick={() => setEditing({ value: BLANK })}>
            <Plus className="h-4 w-4" /> Add provider
          </Button>
        }
      />
      <Panel>
        <RegistryTable
          rows={providers}
          emptyTitle="No providers configured"
          columns={[
            {
              header: "Provider",
              cell: (p) => (
                <div>
                  <p className="text-sm font-medium">{p.displayName}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {p.id} · {p.type}
                  </p>
                </div>
              ),
            },
            {
              header: "Model",
              cell: (p) => (
                <span className="font-mono text-xs">
                  {p.model || <span className="text-muted-foreground">—</span>}
                </span>
              ),
            },
            {
              header: "Method",
              className: "hidden md:table-cell",
              cell: (p) => (
                <span className="font-mono text-xs text-muted-foreground">
                  {p.connectionMethod}
                </span>
              ),
            },
            {
              header: "Status",
              cell: (p) => (
                <Pill tone={STATUS[p.connectionStatus][1]}>{STATUS[p.connectionStatus][0]}</Pill>
              ),
            },
            {
              header: "Enabled",
              cell: (p) => (
                <Switch
                  checked={p.enabled}
                  aria-label={`Toggle ${p.displayName}`}
                  onCheckedChange={(c) => {
                    if (c && !p.model.trim()) {
                      toast.error("Set a model before enabling");
                      return;
                    }
                    actions.upsertProvider({ ...p, enabled: c });
                  }}
                />
              ),
            },
          ]}
          onEdit={(p) => setEditing({ value: p, originalId: p.id })}
          onDelete={(p) => {
            if (profiles.some((pr) => pr.providerId === p.id)) {
              toast.error("A profile still references this provider");
              return;
            }
            actions.deleteProvider(p.id);
          }}
        />
      </Panel>
      <EntityFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.originalId ? "Edit provider" : "Add provider"}
        description="Configuration metadata only. API keys are never entered or stored here."
        fields={fields}
        initial={editing?.value ?? BLANK}
        onSubmit={save}
      />
    </div>
  );
}
