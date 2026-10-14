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

A browser dashboard for supervising visual desktop-agent tasks, with two worker modes:

- **DEMO** — a typed mock worker that simulates tasks end-to-end. Every simulated step is tagged `SIMULATED`.
- **REAL LOCAL** — a Python worker that runs **on your own Windows PC** and performs a small allowlist of
  screenshot, mouse and keyboard actions on your real desktop. It binds to `127.0.0.1` only and is never exposed
  to the network.

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

The console prints a one-time **PAIRING CODE** (valid for 5 minutes, single use).

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

## AI task planning (Local Qwen, Module 3)

Task planning calls `POST /api/tasks/plan` (registered in `src/routes/api/tasks/plan.ts` →
`src/lib/server/task-plan.ts`) or connects directly from the browser to local Qwen.

- Planning runs exclusively through a local `llama-server` instance serving model alias `qwen`
  at `http://127.0.0.1:8081`. Remote planning APIs (Google Gemini, Lovable AI Gateway) are not
  used and require no API keys.
- Security: the route accepts only (a) same-origin browser requests that positively prove it —
  matching `Origin`/`Referer` (or `Sec-Fetch-Site: same-origin` plus a matching header) — or
  (b) internal clients presenting `Authorization: Bearer <DESKTOPPILOT_SERVER_TOKEN>`.
  Requests without origin evidence are rejected; bodies are capped at 64 KB and limited to
  30 planning requests per origin per minute.
- The planner prompt pins the selected desktop target ID, and both the server and client
  planner (`normalizeProviderPlan`) reject steps that target another desktop, use a
  non-allowlisted action, exceed 12 steps, or use `text_match` verification without
  `expectedText`. Schemas: `worker_ok` and `screen_capture` always; `clipboard` for copy steps.
- Verification: `screen_capture` needs a real screenshot; `text_match` compares
  `expectedText` with text the worker returns. When the worker supplies no text (OCR is a
  later extension), the step is recorded as **unverified** — never silently passed — and
  execution continues without retry. Only genuine failures trigger the bounded 2-retry loop;
  tasks also honor a global 10-minute deadline.

### Acceptance test (real local Qwen + real worker)

1. Start `llama-server` with model alias `qwen` on `http://127.0.0.1:8081`.
2. Start and pair the worker (sections 2–3 above), keep the dashboard on **REAL LOCAL** with
   the target's interaction mode set to *assisted* or *autonomous*.
3. Create a task such as "Open Notepad and type DesktopPilot test 123" on the target, and start it.
4. Expected: a local Qwen plan appears, steps run one at a time on the real desktop with approval
   prompts for input actions, and the task ends `completed` only if every verification passed
   (or was honestly recorded as unverified).

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

| Symptom | Fix |
| --- | --- |
| `No signing key found` | Run `python -m desktoppilot_worker setup` |
| `Port 8765 is already in use` | Close the other worker window, or free it: `Get-NetTCPConnection -LocalPort 8765 -State Listen \| Select-Object -ExpandProperty OwningProcess` then `Stop-Process -Id <that number>` |
| Dashboard: "Could not reach the worker" | Worker running? Port matches Settings? Exact page origin in `allowed_origins` (restart after editing)? Local-network access allowed? On Safari, use local development |
| `origin_not_allowed` in the worker log | Add the logged origin to `allowed_origins` and restart |
| 401 "rejected the session" | Token expired or key rotated — restart the worker and pair again |
| `409 observation_stale` / `screen_changed` | Capture again (observations last 60 s) |
| `423 failsafe_triggered` | Mouse hit a screen corner; reset the Emergency Stop |
| Clicks land wrong | Use the main display (multi-monitor/DPI not supported yet) |

## Module 3: Local Qwen task planning

DesktopPilot keeps the AI planning layer separate from the desktop worker. Planning uses the local `llama-server` (model alias `qwen`) listening on `http://127.0.0.1:8081`. The dashboard routes planning through local Qwen directly or via `POST /api/tasks/plan`, returning bounded, schema-validated plans. The task runner then validates every action, applies target approval policy, executes through the paired worker, captures post-action observations, and requires verification before advancing.

This project keeps the adapter logic in `src/lib/ai/provider.ts` and the task lifecycle helpers in `src/lib/tasks/*` so the worker remains allowlisted and the planner can be swapped without changing the worker contract. Demo mode uses the mock provider and worker through the same orchestration path. Remote planning services (Gemini, OpenAI, Anthropic) are not used for planning.

Backend configuration example:

```sh
export LOCAL_LLM_BASE_URL="http://127.0.0.1:8081"
export LOCAL_LLM_MODEL="qwen"
```

## Project layout

```
src/                     Dashboard (TanStack Start, React 19, Tailwind v4)
  lib/types.ts           Task, action and worker types
  lib/worker/            DesktopWorker interface, mock + local HTTP adapters, validation, token store
  store/app-store.ts     Single source of truth for state and task lifecycle
  routes/                Pages (dashboard, settings)
worker/visual-agent/     Python worker (Windows), with tests using a fake desktop
```

## Worker-side development

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q tests
```

Tests use a fake desktop and don't move your mouse.

## Built with

TanStack Start · TypeScript · React · Tailwind CSS · Python (worker)

## Module 4: See and adapt

In REAL LOCAL mode, after each step that changes the screen (click, typing, keys, focusing a window, paste) the dashboard takes a fresh screenshot and asks Gemini whether the step worked:

- **Looks right**: the task continues.
- **Could not tell**: recorded as unverified, and the task continues. It never counts as a pass.
- **Unexpected screen**: Gemini plans the remaining steps again from the current screen. The new steps run without asking you again, **only if** they use the same target, action types, keys, and typed text you approved. If not, the task stops with "The plan needed actions you didn't approve. Start the task again to review them."

Limits: at most 3 plan adjustments per task, 20 steps in total, and 15 seconds per check. Stop works at all times.

**Privacy:** while this is on, screenshots of your screen are sent to Google Gemini (through Lovable AI, or with your `GEMINI_API_KEY` when you run locally). They are never saved. Turn it off in **Settings → See and adapt**. Demo mode only shows simulated checks.

**Manual test (on your PC):** pair the helper, set the target to Notepad, and run "Open Notepad and type hello". Approve the plan, then close Notepad right after it opens. The timeline should show "Unexpected screen — adjusting plan", then "Plan adjusted (1/3)", and the task should reopen Notepad and finish. Also press Stop during "Checking the screen…" to confirm it halts.

## Local model fallback (llama.cpp)

When Gemini fails (quota, server error, network, bad answer), the dashboard can plan with a model running on your own PC.

1. Start `llama-server` with the model alias `qwen` (for example via your `run-model.bat`).
2. Open **Settings → AI provider**. Pick **Auto** (Gemini first, then local), **Gemini only**, or **Local only**. Then press **Test local model**.
3. The header badge shows which AI is answering: **Gemini** (green), **Local** (blue), or **Offline** (red).

After a Gemini failure, the app uses the local model for 5 minutes, or for the wait time Google gives. After that it tries Gemini again.

**Port clash:** llama-server and the local dashboard both use port 8080 by default. If you run the dashboard on your PC, the app now expects llama-server on port 8081 — start it with `--port 8081`.

**Limits:** the local model can't see screenshots, so screen checks are skipped while it's in use. Plans are slow on CPU (up to 5 minutes). The same safety checks apply to every local plan.
