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

## AI task planning (Gemini, Module 3)

Task planning calls `POST /api/tasks/plan` (registered in `src/routes/api/tasks/plan.ts` →
`src/lib/server/task-plan.ts`).

- Configure a Gemini key as the server-side secret/env var `GEMINI_API_KEY` (never `VITE_*`,
  never in browser code). Optionally set `GEMINI_MODEL` (default `gemini-2.5-flash`). See
  `.env.example`.
- Security: the route accepts only (a) same-origin browser requests that positively prove it —
  matching `Origin`/`Referer` (or `Sec-Fetch-Site: same-origin` plus a matching header) — or
  (b) internal clients presenting `Authorization: Bearer <DESKTOPPILOT_SERVER_TOKEN>`.
  Requests without origin evidence are rejected; bodies are capped at 64 KB and limited to
  30 planning requests per origin per minute.
- The server prompt pins the selected desktop target ID, and both the server and the client
  planner (`normalizeProviderPlan`) reject steps that target another desktop, use a
  non-allowlisted action, exceed 12 steps, or use `text_match` verification without
  `expectedText`. Schemas: `worker_ok` and `screen_capture` always; `clipboard` for copy steps.
- Verification: `screen_capture` needs a real screenshot; `text_match` compares
  `expectedText` with text the worker returns. When the worker supplies no text (OCR is a
  later extension), the step is recorded as **unverified** — never silently passed — and
  execution continues without retry. Only genuine failures trigger the bounded 2-retry loop;
  tasks also honor a global 10-minute deadline.

### Acceptance test (real Gemini + real worker)

1. Set `GEMINI_API_KEY`, start and pair the worker (sections 2–3 above), keep the dashboard on
   **REAL LOCAL** with the target's interaction mode set to *assisted* or *autonomous*.
2. Create a task such as "Open Notepad and type DesktopPilot test 123" on the target, and start it.
3. Expected: a Gemini plan appears, steps run one at a time on the real desktop with approval
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
| Dashboard: "Could not reach the worker" | Worker running? Port matches Settings? Exact page origin in `allowed_origins` (restart after editing)? Local-network access allowed? On Safari, use local development |
| `origin_not_allowed` in the worker log | Add the logged origin to `allowed_origins` and restart |
| 401 "rejected the session" | Token expired or key rotated — restart the worker and pair again |
| `409 observation_stale` / `screen_changed` | Capture again (observations last 60 s) |
| `423 failsafe_triggered` | Mouse hit a screen corner; reset the Emergency Stop |
| Clicks land wrong | Use the main display (multi-monitor/DPI not supported yet) |

## Module 3: Gemini-backed task orchestration

DesktopPilot keeps the AI provider adapter separate from the desktop worker. Gemini is the default provider, and the API key is read only on the trusted local backend; the browser never gets a private key. The dashboard calls `/api/tasks/plan`, and the server uses the official Google GenAI SDK to call Gemini before returning a bounded, schema-validated plan. The task runner then validates every action, applies target approval policy, executes through the paired worker, captures post-action observations, and requires verification before advancing.

This project keeps the adapter logic in `src/lib/ai/provider.ts` and the task lifecycle helpers in `src/lib/tasks/*` so the worker remains allowlisted and the planner can be swapped without changing the worker contract. Demo mode uses the mock provider and worker through the same orchestration path; OpenAI, Anthropic, and custom providers remain explicitly unsupported.

Backend configuration example:

```sh
export GEMINI_API_KEY="replace_with_your_key"
export GEMINI_MODEL="gemini-2.5-flash"
```

For local server configuration, copy `.env.example` to `.env` and provide a real key only in the trusted server environment. Never use `VITE_GEMINI_API_KEY`, commit `.env`, or place credentials in browser storage.

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
