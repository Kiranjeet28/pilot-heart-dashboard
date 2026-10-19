<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

# DesktopPilot

A browser dashboard for supervising desktop-agent tasks through an authenticated local Python worker. The
production UI runs real tasks only; mocks are used by automated tests and are not task-runner adapters.
The worker binds to `127.0.0.1` and accepts only a small allowlist of desktop actions.

Real desktop control is **not confirmed** until you run the guided Notepad test (below) on your machine.

## Prerequisites

- **Dashboard:** Node.js 20+ (or Bun) and npm
- **Worker (Windows PC only):** Python 3.11+ from python.org — tick "Add python.exe to PATH" during install

## 1. Run the dashboard

```sh
npm install        # or: bun install
npm run dev        # or: bun run dev
```

Open the printed address, typically `http://localhost:8080`. To use the real worker from this local
dashboard, `http://localhost:8080` is already a suitable entry for the worker's `allowed_origins`.

Other scripts:

```sh
npm run test       # vitest (unit + integration tests)
npm run test:watch
npm run lint
npm run build      # production build
```

## 2. Run the local worker (Windows)

Easiest way — one command from the project root. It creates the Python environment,
installs dependencies, frees port 8765 from a previous helper run, and starts the helper:

```powershell
.\start-worker.ps1        # or: bash start-worker.sh (Git Bash/WSL/Linux/macOS)
```

Manual setup, if you prefer doing it by hand:

```powershell
cd worker\visual-agent
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item config.example.json config.json
notepad config.json
```

In `config.json`:

- `port` — default `8765`. If you change it, set the same port in the dashboard's **Settings → Local worker connection**.
- `allowed_origins` — the exact dashboard addresses allowed to call the worker, e.g. the Lovable preview URL,
  your published URL, and `http://localhost:8080` for local development. Wildcards (`*`) are rejected.

Start it:

```powershell
.\.venv\Scripts\python.exe -m desktoppilot_worker setup          # once: stores the signing key in Windows Credential Manager
.\.venv\Scripts\python.exe -m desktoppilot_worker run --config config.json
```

The console prints a one-time **PAIRING CODE** (valid for 30 minutes, single use).

## 3. Pair the dashboard

1. In the dashboard, open **Settings**, choose **REAL LOCAL**, enter the pairing code, click **Pair**.
2. If the browser asks to allow access to devices on your local network, allow it **for this site only**.
3. Status becomes **Connected** only after an authenticated health check succeeds.

Sanity check from PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

## 4. Guided Notepad test (acceptance)

1. Open a **new, empty** Notepad window next to the browser.
2. Go to **Settings → Guided Notepad test**, tick "I opened an empty Notepad window", click **Capture desktop**,
   and confirm the "Allow real desktop actions" prompt.
3. Click inside Notepad's text area in the screenshot, then click **Run test**.
4. Expected: Notepad shows `DesktopPilot test 123` on two lines and the report confirms the copied length (21).
   Close Notepad **without saving**.

Stop behaviour: press **Stop** (or the header **Emergency Stop**) while the test runs — remaining steps are not
sent, and the worker answers `423 worker_stopped` until the emergency stop is reset.

## AI task planning

The Main page offers Local Model, Gemini, and Grok. Selection is included in the planning request and each choice is routed to its matching implementation; provider errors do not silently switch providers. Local Model runs llama.cpp in the browser against the loopback URL in Settings. The server planning route uses `LOCAL_LLM_BASE_URL` and `LOCAL_LLM_MODEL` (defaults `http://127.0.0.1:8081` and `qwen`) and rejects non-loopback destinations. Gemini uses `GEMINI_API_KEY` / optional `GEMINI_MODEL`; Grok uses `XAI_API_KEY` / optional `XAI_MODEL`. Keep credentials in the server environment, never browser settings.

`POST /api/tasks/plan` validates provider IDs, request schemas, target IDs, and generated actions. It requires positive same-origin evidence or `Authorization: Bearer <DESKTOPPILOT_SERVER_TOKEN>`, caps the request body at 64 KiB, and applies bounded rate limiting. The text-only planner receives no screenshot and must not produce click steps. A click requires coordinates tied to a fresh screenshot observation and is rejected if visual grounding is unavailable. The worker independently revalidates actions and bounds.

Supported worker actions include approved Notepad launch, click, type text (500 characters maximum), key press, wait (10,000 ms maximum), copy selection, and paste. The worker allowlist is the final enforcement boundary. The task runner validates a complete plan before executing it, applies target approval policy, bounds replanning and deadlines, and reports unavailable verification as unverified rather than claiming success. Emergency Stop blocks further worker actions.

Server environment example (leave secrets out of documentation and source control):

```dotenv
LOCAL_LLM_BASE_URL=http://127.0.0.1:8081
LOCAL_LLM_MODEL=qwen
GEMINI_MODEL=gemini-3.8-flash
GEMINI_API_KEY=
XAI_MODEL=grok-4.7
XAI_API_KEY=
```

For Local Model, configure the loopback endpoint and model alias in Settings. Use each provider's Test button to verify an actual inference response; configured values alone do not prove connectivity.
## Security model

- The worker binds to `127.0.0.1` only; `Host` and `Origin` headers are checked against an allowlist (no `*`).
- All action endpoints require a signed, expiring session token (issued only via the pairing code); the token
  lives in the tab's `sessionStorage` only, never in URLs or logs.
- `/stop` works without a token so the emergency stop always functions.
- Actions are allowlisted in **both** the dashboard (`src/lib/worker/key-allowlist.ts`) and the worker
  (`worker/visual-agent/desktoppilot_worker/actions.py`) — they must change together. No shell, code execution,
  file, password or cookie access.
- Clipboard copies return only length + hash, never the text. Logs redact tokens and never record typed text.
- PyAutoGUI fail-safe (mouse into a screen corner) plus the dashboard Emergency Stop and Ctrl+C.
- Run the worker as your normal user — never as Administrator.
- The dashboard persists configuration and task history in browser-local storage only; profiles store credential
  **reference names**, never secrets.

## Troubleshooting

See the detailed table in [`worker/visual-agent/README.md`](worker/visual-agent/README.md). Common ones:

| Symptom                                    | Fix                                                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No signing key found`                     | Run `python -m desktoppilot_worker setup`                                                                                                                                            |
| `Port 8765 is already in use`              | Close the other worker window, or free it: `Get-NetTCPConnection -LocalPort 8765 -State Listen \| Select-Object -ExpandProperty OwningProcess` then `Stop-Process -Id <that number>` |
| Dashboard: "Could not reach the worker"    | Worker running? Port matches Settings? Exact page origin in `allowed_origins` (restart after editing)? Local-network access allowed? On Safari, use local development                |
| `origin_not_allowed` in the worker log     | Add the logged origin to `allowed_origins` and restart                                                                                                                               |
| 401 "rejected the session"                 | Token expired or key rotated — restart the worker and pair again                                                                                                                     |
| `409 observation_stale` / `screen_changed` | Capture again (observations last 60 s)                                                                                                                                               |
| `423 failsafe_triggered`                   | Mouse hit a screen corner; reset the Emergency Stop                                                                                                                                  |
| Clicks land wrong                          | Use the main display (multi-monitor/DPI not supported yet)                                                                                                                           |

## See and adapt

After screen-changing actions, the app can send an in-memory screenshot to the server-side screen-check provider when adaptive checks are enabled. Check errors become unverified; only a clearly off-track result may trigger bounded replanning. Local Model planning itself is text-only and cannot ground clicks from a screenshot. Screenshots are not persisted. Configure the screen-check service credentials on the server and verify availability with a real task; no live connectivity is implied by having a key configured.