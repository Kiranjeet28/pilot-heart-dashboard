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
- UI talks to the desktop only through `DesktopWorker` (src/lib/worker/worker.ts); swap MockDesktopWorker for a live adapter there — keeps the dashboard worker-agnostic.
- Workers accept only `ValidatedActionRequest` from `validateAction` (allowlisted kinds, no shell/code exec) — prevents unchecked actions reaching a real desktop.
- All state mutations go through `actions` in src/store/app-store.ts; task status changes must pass `canTransition` — single source of truth for the task lifecycle.
- Every activity event carries `simulated`; mock output must always set it true — the UI must never present simulated actions as real.
- Persistence is browser-local (src/lib/persistence) with config and task history in separate keys; profiles store only credential reference names, never secrets.
- Provider/profile/target forms use the data-driven EntityFormDialog — keeps registries consistent and validated.
