// Saved prompts for the Prompt Workspace. Browser-local, never contains secrets.
import { useSyncExternalStore } from "react";
import { load, save } from "@/lib/persistence/local-store";

export interface SavedPrompt {
  id: string;
  title: string;
  prompt: string;
  context: string;
  createdAt: number;
  lastUsedAt?: number;
}

export const MAX_SAVED_PROMPTS = 100;

let prompts: SavedPrompt[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const EMPTY: SavedPrompt[] = [];

function ensure() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  prompts = load<SavedPrompt[]>("prompts") ?? [];
}
function commit(next: SavedPrompt[]) {
  prompts = next;
  save("prompts", prompts);
  listeners.forEach((l) => l());
}

export function titleFor(prompt: string) {
  const one = prompt.trim().replace(/\s+/g, " ");
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

/** Case-insensitive search over title, prompt and context. */
export function searchPrompts(list: SavedPrompt[], q: string): SavedPrompt[] {
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter((p) => `${p.title} ${p.prompt} ${p.context}`.toLowerCase().includes(s));
}

export const promptStore = {
  list: () => (ensure(), prompts),
  save(prompt: string, context: string): SavedPrompt | null {
    ensure();
    const text = prompt.trim();
    if (!text) return null;
    const existing = prompts.find((p) => p.prompt === text && p.context === context.trim());
    if (existing) return existing;
    const item: SavedPrompt = {
      id: `prompt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: titleFor(text),
      prompt: text,
      context: context.trim(),
      createdAt: Date.now(),
    };
    commit([item, ...prompts].slice(0, MAX_SAVED_PROMPTS));
    return item;
  },
  touch(id: string) {
    ensure();
    commit(prompts.map((p) => (p.id === id ? { ...p, lastUsedAt: Date.now() } : p)));
  },
  remove(id: string) {
    ensure();
    commit(prompts.filter((p) => p.id !== id));
  },
};

export function useSavedPrompts(): SavedPrompt[] {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => promptStore.list(),
    () => EMPTY,
  );
}
