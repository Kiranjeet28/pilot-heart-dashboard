import type { AccountProfile, DesktopTarget, Provider, Task } from "@/lib/types";
import { isActive } from "@/lib/tasks/state-machine";

export interface ReadinessInput {
  providerId: string;
  profileId: string;
  targetId: string;
  providers: Provider[];
  profiles: AccountProfile[];
  targets: DesktopTarget[];
  tasks: Task[];
  emergencyStop: boolean;
  worker: { connected: boolean; message: string };
}

/** Returns blocking issues; empty array means a task may start. */
export function checkReadiness(i: ReadinessInput): string[] {
  const issues: string[] = [];
  if (i.emergencyStop)
    issues.push("Emergency stop is engaged. Reset it in the header or Settings.");
  const provider = i.providers.find((p) => p.id === i.providerId);
  if (!provider) issues.push("Select an AI provider.");
  else {
    if (!provider.enabled) issues.push(`Provider "${provider.displayName}" is disabled.`);
    if (!provider.model.trim())
      issues.push(`Provider "${provider.displayName}" has no model configured.`);
  }
  const profile = i.profiles.find((p) => p.id === i.profileId);
  if (!profile) issues.push("Select an account profile.");
  else if (provider && profile.providerId !== provider.id)
    issues.push(`Profile "${profile.name}" belongs to a different provider.`);
  if (!i.targets.some((t) => t.id === i.targetId)) issues.push("Select a desktop target.");
  if (!i.worker.connected) issues.push(`Real worker not connected: ${i.worker.message}`);
  if (i.tasks.some((t) => isActive(t.status)))
    issues.push("Another task is active. Finish or cancel it first.");
  return issues;
}
