// Generic data-driven form dialog used by the provider, profile and target registries.
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type FieldDef<T> = {
  name: keyof T & string;
  label: string;
  type: "text" | "textarea" | "select" | "switch";
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  validate?: (value: unknown, all: T) => string | undefined;
};

export function EntityFormDialog<T extends Record<string, unknown>>({
  open, onOpenChange, title, description, fields, initial, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  fields: FieldDef<T>[];
  initial: T;
  onSubmit: (value: T) => void;
}) {
  const [value, setValue] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setValue(initial); setErrors({}); } }, [open, initial]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const err = f.validate?.(value[f.name], value);
      if (err) errs[f.name] = err;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    onSubmit(value);
    onOpenChange(false);
  }

  const setField = (k: string, v: unknown) => setValue((p) => ({ ...p, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {fields.map((f) => {
            const v = value[f.name];
            const id = `f-${f.name}`;
            return (
              <div key={f.name} className="space-y-1.5">
                {f.type === "switch" ? (
                  <div className="flex items-center justify-between">
                    <Label htmlFor={id}>{f.label}</Label>
                    <Switch id={id} checked={Boolean(v)} onCheckedChange={(c) => setField(f.name, c)} />
                  </div>
                ) : (
                  <>
                    <Label htmlFor={id}>{f.label}</Label>
                    {f.type === "text" ? (
                      <Input id={id} value={String(v ?? "")} placeholder={f.placeholder} className={f.mono ? "font-mono" : undefined} onChange={(e) => setField(f.name, e.target.value)} />
                    ) : f.type === "textarea" ? (
                      <Textarea id={id} value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => setField(f.name, e.target.value)} />
                    ) : (
                      <Select value={String(v ?? "")} onValueChange={(nv) => setField(f.name, nv)}>
                        <SelectTrigger id={id}><SelectValue placeholder={f.placeholder ?? "Select…"} /></SelectTrigger>
                        <SelectContent>
                          {(f.options ?? []).map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </>
                )}
                {errors[f.name] ? <p className="text-xs text-destructive">{errors[f.name]}</p> : f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
              </div>
            );
          })}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export const required = (label: string) => (v: unknown) => (String(v ?? "").trim() ? undefined : `${label} is required`);
export const slugId = (existing: string[], originalId?: string) => (v: unknown) => {
  const s = String(v ?? "");
  if (!s) return "ID is required";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(s)) return "Use 2–40 lowercase letters, digits or hyphens";
  if (s !== originalId && existing.includes(s)) return "ID already exists";
  return undefined;
};
