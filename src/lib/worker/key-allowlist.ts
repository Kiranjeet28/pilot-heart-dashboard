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
  "ctrl+,",
  "shift+home",
  "shift+end",
  "windows",
  "windows+r",
  "windows+e",
  "windows+d",
] as const;

export const MAX_ACTION_TEXT = 500;
export const MAX_WAIT_MS = 10000;
