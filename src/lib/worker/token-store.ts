// Holds the worker session token in sessionStorage only (cleared when the tab closes).
// Never put the token in URLs, logs, activity events, or persisted app state.
const KEY = "desktoppilot.worker.session";

export interface WorkerSession {
  token: string;
  expiresAt: number; // unix seconds
}

export function readSession(): WorkerSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as WorkerSession;
    if (typeof s.token !== "string" || typeof s.expiresAt !== "number") return null;
    if (s.expiresAt * 1000 <= Date.now()) {
      clearSession();
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function writeSession(s: WorkerSession) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(KEY);
}
