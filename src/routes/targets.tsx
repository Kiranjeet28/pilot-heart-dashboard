import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { actions, useAppState } from "@/store/app-store";
import { pageMeta } from "@/lib/meta";
import type { DesktopTarget } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Panel, PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-badge";
import { RegistryTable } from "@/components/registry-table";
import { EntityFormDialog, required, slugId, type FieldDef } from "@/components/entity-form-dialog";

export const Route = createFileRoute("/targets")({
  head: () =>
    pageMeta("Desktop targets", "Registry of Windows applications DesktopPilot can work with."),
  component: TargetsPage,
});

const BLANK: DesktopTarget = {
  id: "",
  displayName: "",
  kind: "custom",
  launchPath: "",
  windowTitleContains: "",
  processName: "",
  interactionMode: "assisted",
};

function TargetsPage() {
  const targets = useAppState((s) => s.targets);
  const [editing, setEditing] = useState<{ value: DesktopTarget; originalId?: string } | null>(
    null,
  );

  const fields: FieldDef<DesktopTarget>[] = [
    {
      name: "displayName",
      label: "Display name",
      type: "text",
      validate: required("Display name"),
    },
    {
      name: "id",
      label: "Target ID",
      type: "text",
      mono: true,
      validate: slugId(
        targets.map((t) => t.id),
        editing?.originalId,
      ),
    },
    {
      name: "kind",
      label: "Kind",
      type: "select",
      options: [
        { value: "vscode", label: "Visual Studio Code" },
        { value: "cursor", label: "Cursor" },
        { value: "browser_chat", label: "Browser-based AI chat" },
        { value: "custom", label: "Custom Windows app" },
      ],
    },
    {
      name: "launchPath",
      label: "Launch path (optional)",
      type: "text",
      mono: true,
      placeholder: "Set on your machine only",
      hint: "Stored as configuration. The web dashboard never launches applications.",
      validate: (v) => (String(v ?? "").length > 260 ? "Path too long (max 260)" : undefined),
    },
    {
      name: "windowTitleContains",
      label: "Window title contains",
      type: "text",
      validate: (v, all) =>
        !String(v).trim() && !all.processName.trim()
          ? "Provide a title or process rule"
          : undefined,
    },
    {
      name: "processName",
      label: "Process name",
      type: "text",
      mono: true,
      placeholder: "Code.exe",
      validate: (v) =>
        v && !/^[\w.-]+\.exe$/i.test(String(v)) ? "Use a process name like App.exe" : undefined,
    },
    {
      name: "interactionMode",
      label: "Interaction mode",
      type: "select",
      options: [
        { value: "observe_only", label: "Observe only" },
        { value: "assisted", label: "Assisted (approval for input)" },
        { value: "autonomous", label: "Autonomous" },
      ],
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Desktop targets"
        description="Targets show as disconnected until a local Windows worker reports them."
        actions={
          <Button onClick={() => setEditing({ value: BLANK })}>
            <Plus className="h-4 w-4" /> Add target
          </Button>
        }
      />
      <Panel>
        <RegistryTable
          rows={targets}
          emptyTitle="No targets configured"
          columns={[
            {
              header: "Target",
              cell: (t) => (
                <div>
                  <p className="text-sm font-medium">{t.displayName}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {t.id} · {t.kind}
                  </p>
                </div>
              ),
            },
            {
              header: "Window match",
              className: "hidden md:table-cell",
              cell: (t) => (
                <span className="font-mono text-xs text-muted-foreground">
                  {[
                    t.windowTitleContains && `title~"${t.windowTitleContains}"`,
                    t.processName && `proc=${t.processName}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ),
            },
            {
              header: "Mode",
              cell: (t) => <span className="font-mono text-xs">{t.interactionMode}</span>,
            },
            {
              header: "Status",
              cell: () => (
                <div className="flex gap-1">
                  <Pill tone="info">configured</Pill>
                  <Pill tone="muted">disconnected</Pill>
                </div>
              ),
            },
          ]}
          onEdit={(t) => setEditing({ value: t, originalId: t.id })}
          onDelete={(t) => actions.deleteTarget(t.id)}
        />
      </Panel>
      <EntityFormDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.originalId ? "Edit target" : "Add target"}
        fields={fields}
        initial={editing?.value ?? BLANK}
        onSubmit={(t) => {
          actions.upsertTarget(t, editing?.originalId);
          toast.success("Target saved");
        }}
      />
    </div>
  );
}
