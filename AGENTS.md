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

## Architecture rules
- UI talks to the desktop only through `DesktopWorker` (src/lib/worker/worker.ts); the store selects MockDesktopWorker (DEMO) or LocalHttpWorker (REAL LOCAL) by settings.workerMode — keeps the dashboard worker-agnostic. Extend the interface only with optional members.
- Workers accept only `ValidatedActionRequest` from `validateAction` (allowlisted kinds, no shell/code exec) — prevents unchecked actions reaching a real desktop.
- All state mutations go through `actions` in src/store/app-store.ts; task status changes must pass `canTransition` — single source of truth for the task lifecycle.
- Every activity event carries `simulated`; mock output must always set it true — the UI must never present simulated actions as real.
- Persistence is browser-local (src/lib/persistence) with config and task history in separate keys; profiles store only credential reference names, never secrets.
- Provider/profile/target forms use the data-driven EntityFormDialog — keeps registries consistent and validated.
- The Python worker in worker/visual-agent binds only to 127.0.0.1, checks Host + Origin allowlist, and requires a signed session token for all action endpoints (except /stop) — the hosted app must never get unrestricted desktop access.
- Worker action allowlists exist twice (src/lib/worker/key-allowlist.ts and worker/visual-agent/desktoppilot_worker/actions.py) and must change together — the worker re-validates everything.
- Real screenshots and the worker session token are never persisted (token lives in sessionStorage only) — avoids leaking desktop contents or credentials.

## Module 3 (AI task planning)
- `/api/tasks/plan` (src/routes/api/tasks/plan.ts) is the single AI planning route (Lovable AI gateway via `src/lib/server/task-plan.ts`); it self-authenticates via same-origin evidence or the `DESKTOPPILOT_SERVER_TOKEN` bearer — keep missing origin/referer headers untrusted and the rate limiter and 64 KB body cap in place.
- AI plans are validated twice: server-side (strict JSON schema + selected-target enforcement) and client-side (`normalizeProviderPlan`: allowlist, target match, observe-only policy, `text_match` requires `expectedText`).
- Verification must use real worker evidence: missing observed text is `unverified` (recorded, no retry, never a silent pass); only `failed` triggers the bounded 2-retry loop.

## Module 4 (see-and-adapt loop)
- After each screen-changing real step the runner posts the fresh screenshot to `/api/tasks/check` (src/lib/server/step-check.ts), which shares auth/rate-limit guards with `/api/tasks/plan`; screenshots are used in memory only, never stored or logged.
- Check failures become `unsure` (unverified, continue) — never a silent pass. Only `off_track` replans, through the existing plan route with "continue from here" context.
- Replanned steps must pass `isWithinApprovedScope` (src/lib/tasks/adapt.ts: same target, approved kinds/keys/typed text; wait/read_screen always allowed) or the task fails — the single pre-start approval stays the only prompt. Limits: 3 replans, 20 steps, 15 s per check.
- DEMO mode logs simulated checks only and never sends a screen to the AI.
