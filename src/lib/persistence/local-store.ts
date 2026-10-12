// Browser-local persistence. Configuration and task history are stored in SEPARATE keys,
// and neither ever contains secrets. Swap for a backend adapter later behind the same API.
const PREFIX = "desktoppilot.v1.";

export type StoreKey = "config" | "tasks" | "activity" | "settings";

export function load<T>(key: StoreKey): T | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function save(key: StoreKey, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota or privacy mode — ignore */
  }
}

export function clearAll() {
  if (typeof window === "undefined") return;
  (["config", "tasks", "activity", "settings"] as StoreKey[]).forEach((k) => window.localStorage.removeItem(PREFIX + k));
}
