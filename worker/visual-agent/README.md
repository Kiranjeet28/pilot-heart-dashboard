# DesktopPilot local visual agent (Milestone 2)

A small Python service that runs **on your own Windows PC** and lets the DesktopPilot dashboard
capture screenshots and perform a short allowlist of mouse/keyboard actions. It listens on
`127.0.0.1` only. It is never deployed, never exposed on `0.0.0.0`, and needs no port forwarding.

> Status: built and covered by automated tests (with a fake desktop). Real desktop control is
> **not confirmed** until you run the Notepad test below on your machine.

## What it can do

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | optional | Availability and version. With a valid token, also reports busy/stopped/screen size |
| `POST /pair` | pairing code | Swap the one-time console code for a session token |
| `GET /capabilities` | token | Supported actions, keys and limits |
| `POST /observe` | token | Capture a screenshot. Returns an `observation_id` |
| `POST /actions` | token | Run **one** validated action |
| `POST /cancel` | token | Cancel a task. Its pending and future actions are rejected |
| `POST /stop` | allowed origin | Stop accepting actions and interrupt the current one (no token, so an emergency stop always works) |
| `POST /resume` | token | Accept actions again |

Allowed actions are `click` (needs a fresh observation, bounds-checked), `type_text` (≤500 printable ASCII characters),
`key_press` (allowlist: enter, tab, escape, backspace, delete, space, arrows, home/end, page up/down,
ctrl+a/c/v/z, shift+home/end), `copy_selection` (returns only length + hash, never the text), `paste`, and `wait` (≤10 s).
There is **no** shell, Python execution, file access, password or cookie access.

## Start (one command)

From the project root, run the start script — it creates the environment, installs
dependencies, frees the port from a previous helper run, and starts the helper:

```powershell
cd path\to\pilot-heart-dashboard
.\start-worker.ps1
```

(Or, inside Git Bash/WSL on Windows, or on Linux/macOS: `bash start-worker.sh`.)

The first run takes a minute or two to install dependencies; later runs start immediately.

## Manual install (PowerShell, if you prefer doing it by hand)

Requires Python 3.11+ from python.org (tick "Add python.exe to PATH").

```powershell
cd path\to\DesktopPilot\worker\visual-agent
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config.example.json config.json
notepad config.json   # check allowed_origins and port
```

We call `.venv\Scripts\python.exe` directly, so you don't need to change the PowerShell execution policy.

## Configure

`config.json` holds no secrets:

- `port` – default `8765` (1024–65535). If you change it, set the same port in Settings → Local worker connection.
- `allowed_origins` – the exact dashboard addresses allowed to call the worker, e.g. the Lovable preview URL,
  your published URL, and `http://localhost:8080` for local development. `*` is rejected.
- `session_ttl_hours`, `action_timeout_s`, `observe_timeout_s`, `max_observation_age_s`, `max_image_width`, `log_file`.

The host is fixed at `127.0.0.1` and can't be changed.

## Pair

```powershell
.\.venv\Scripts\python.exe -m desktoppilot_worker setup          # once: creates the signing key in Windows Credential Manager
.\.venv\Scripts\python.exe -m desktoppilot_worker run --config config.json
```

The window prints a `PAIRING CODE` (e.g. `K7QM-3XRA`). It works once and expires after 30 minutes. To pair:

1. In the dashboard, open **Settings**, choose **REAL LOCAL**, type the code and click **Pair**.
2. If the browser asks to allow access to devices on your local network, allow it **for this site only**.
3. The status changes to **Connected** only after an authenticated health check succeeds.

To check from PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

To switch back, choose **DEMO** in Settings. Stop the worker with **Ctrl+C**.

## Security design

- **Signing key:** `setup` generates a 256-bit key and stores it in Windows Credential Manager through `keyring`.
  It is never printed or written to disk. `setup --force` rotates it, which invalidates every session.
- **Session token:** an HMAC-SHA256-signed, expiring token (`v1.<expiry>.<nonce>.<sig>`) issued only for a
  valid pairing code. The dashboard keeps it in the tab's `sessionStorage` and sends it only in the
  `Authorization` header. It never appears in URLs, task history, logs or screenshots.
- **Request checks:** the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
  The `Origin` must be on the allowlist. CORS answers only those origins and supports Chrome's Private Network
  Access preflight (`Access-Control-Allow-Private-Network`). Bodies are limited to 16 KB, and after 20 auth
  failures in a minute requests get HTTP 429.
- **Limits:** one action at a time (`409 busy` otherwise), per-action timeouts, a 10 s wait cap, and typing that
  stops character-by-character on stop or cancel.
- **Logs:** tokens and `Bearer` values are redacted. Typed text and clipboard contents are never logged, and
  validation errors never echo input.
- **Fail-safes:** PyAutoGUI fail-safe (move the mouse into a screen corner), the dashboard Emergency Stop
  (`POST /stop`), or Ctrl+C.
- **Privilege:** run as your normal user, never as Administrator. Windows blocks input into elevated windows
  from a non-elevated process, and that's intended.

## Browser notes (HTTPS page → localhost)

Chrome and Edge treat `http://127.0.0.1` as a secure context, so an HTTPS dashboard may call it once the origin
is allowed. Newer versions ask for **local network access** permission the first time. Firefox generally allows it.
**Safari** and some privacy extensions block it.

If the hosted preview can't connect, use the local-development option instead of weakening browser security:
run the dashboard on your PC (`bun install && bun run dev`, which serves `http://localhost:8080`), keep
`http://localhost:8080` in `allowed_origins`, and open that address.

## Manual Notepad test (acceptance)

1. Start the worker and pair as above.
2. Open a **new, empty** Notepad window next to the browser.
3. Go to Settings → **Guided Notepad test**. Tick "I opened an empty Notepad window" and click **Capture desktop**.
   Confirm the "Allow real desktop actions" prompt.
4. In the screenshot, click inside Notepad's text area, then click **Run test**.
5. The worker clicks there, types `DesktopPilot test 123`, presses Ctrl+A, copies, presses End and Enter,
   pastes, waits, and captures a new screenshot.
6. Expected result: Notepad shows the string on two lines, and the report says the copied length (21) matches.
   Close Notepad yourself **without saving**.

Stop test: start step 4 and press **Stop** (or the header Emergency Stop) while it runs. The remaining steps
are not sent. The worker answers `423 worker_stopped` until you reset the emergency stop.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No signing key found` | Run `... -m desktoppilot_worker setup` |
| `Config error: ...` | Fix `config.json` (port range, exact origins, no `*`) |
| `Port 8765 is already in use` | Another worker window (or program) holds it. Close the old window, or free it: `Get-NetTCPConnection -LocalPort 8765 -State Listen \| Select-Object -ExpandProperty OwningProcess` then `Stop-Process -Id <that number>`. Or set a different `port` in `config.json` and match it in Settings |
| `Could not initialise desktop control` | Run from an unlocked, interactive desktop session, not over SSH or as a service |
| Dashboard: "Could not reach the worker" | Is the worker running? Does the port match? Is the exact page origin in `allowed_origins` (restart after editing)? Did you allow local network access? On Safari, use local development |
| `origin_not_allowed` in the worker log | Add the origin shown in the log to `allowed_origins` and restart |
| "rejected the session" / 401 | The token expired or the key was rotated. Restart the worker for a new code and pair again |
| Pairing code rejected | It works once, expires after 30 minutes, and allows 5 attempts. Restart the worker for a new one |
| `409 observation_stale` / `screen_changed` | Capture again (observations last 60 s; display changes invalidate them) |
| `423 failsafe_triggered` | The mouse hit a screen corner. Reset the Emergency Stop in the dashboard |
| Clicks land in the wrong place | Use the main display. Multi-monitor and mixed DPI aren't supported yet |
| Nothing typed into an app | The app may be running as Administrator, so the worker (rightly) can't control it |

## Development

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q tests
```

Tests use a fake desktop and don't move your mouse.

## Later extensions

Windows UI Automation (window focus, element targeting), multi-monitor support, and non-ASCII typing through
the clipboard.
