// Keep in sync with ALLOWED_KEYS in worker/visual-agent/desktoppilot_worker/actions.py.
export const ALLOWED_KEYS = [
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "ctrl+a",
  "ctrl+c",
  "ctrl+v",
  "ctrl+z",
  "shift+home",
  "shift+end",
] as const;

export const MAX_ACTION_TEXT = 500;
export const MAX_WAIT_MS = 10000;
