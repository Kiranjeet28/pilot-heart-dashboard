# Module 4 — See-and-adapt loop

No Module 4 spec exists in the repo (checked README.md, AGENTS.md, docs). This plan is the proposed spec; approving it makes it the source of truth.

## Purpose

Today a plan runs blind: steps run in order, and a check only happens when a step has a `text_match`. If a window opens slowly, a dialog pops up, or a click misses, later steps run against the wrong screen. Module 4 makes the agent look at the screen after each real action, decide whether it worked, and fix the rest of the plan when it didn't.

## What the user sees

- After each real step, the timeline shows a check result: "Looks right", "Unexpected screen — adjusting plan", or "Could not tell".
- When the plan changes, the timeline shows the old and new remaining steps.
- The single approval card before start stays the only prompt (per project memory). A changed plan runs with no extra prompt **only if it stays inside what was approved** (see Safety). If not, the task stops with a clear message: "The plan needed actions you didn't approve. Start the task again to review them."
- Stop works at all times, including during a check or replan.
- A Settings switch "Check the screen after each step" (on by default in REAL LOCAL; off/simulated in DEMO).

## Scope

1. Observe after step: after each real coordinate/keyboard action, a fresh `observe` through `DesktopWorker` (screenshot + window title).
2. Check: new server route `/api/tasks/check` sends the step goal, the expected result, and the screenshot to Gemini. It returns `ok | off_track | unsure` plus a short reason. Strict schema on the server and the client.
3. Replan: on `off_track`, call the existing `/api/tasks/plan` with a "continue from here" context (done steps, current screen summary). It returns the remaining steps only.
4. Bounds: at most 3 replans per task, at most 20 total steps, 15 s timeout per check. Hitting a limit fails the task with a clear reason.
5. DEMO: the mock worker returns simulated checks (always marked simulated). It never calls Gemini with a real screen.

## Safety

- Approved scope = the set of action kinds, keys/shortcuts, and target fixed at approval. A replanned step outside that set (new key, new action kind, different target) is never run; the task stops as described above.
- Replanned steps go through `normalizeProviderPlan` and `validateAction` like any other step. The worker allowlists stay unchanged, and both stay in sync.
- Screenshots go to the check route in memory only. They are never saved to history or local storage, and never logged. The README states that, while checks are on, the screen is sent to Google Gemini.
- `/api/tasks/check` uses the same protections as `/api/tasks/plan`: same-origin or server token, rate limit, body cap (raised only enough for one compressed screenshot, around 1.5 MB), and no keys exposed to the browser.
- `unsure` is recorded as unverified and is never a silent pass. The task continues without replanning (same rule as Module 3).
- A worker disconnect during a check fails the task with "Helper disconnected" and does not retry.

## Technical details

Files to create:

- `src/routes/api/tasks/check.ts`: the route. It reuses the auth, rate-limit, and body-cap helpers from `plan.ts` (extract shared guards into `src/lib/server/route-guards.ts`).
- `src/lib/server/step-check.ts`: the Gemini vision call. It uses the gateway first and falls back to direct `GEMINI_API_KEY`, the same as `task-plan.ts`.
- `src/lib/tasks/adapt.ts`: pure logic for `isWithinApprovedScope`, the replan budget, and merging remaining steps.
- Tests: `adapt.test.ts` (scope, budget, merge), `check-route.test.ts` (auth, bad input, oversize, timeout, schema rejection), runner tests (ok, off_track leading to a replan, out-of-scope stop, unsure, disconnect, stop mid-check).

Files to modify:

- `src/lib/types.ts`: optional `approvedScope`, `replanCount`, and step `checkResult`. All optional, so old records still load.
- `src/store/app-store.ts`: runner loop observe → check → maybe replan. All state changes go through actions and `canTransition`.
- `src/lib/tasks/planner.ts`: plan-request context for "continue from here".
- `src/routes/api/tasks/plan.ts`: optional `progress` field in the input schema.
- Settings UI: one switch. `src/components/current-task.tsx`: show check results and plan changes.
- `README.md` and `AGENTS.md`: new route, data sent to Gemini, limits.

Python worker: no changes (it already has `observe`/screenshot).

## Acceptance criteria

1. All existing 49 tests still pass, plus the new tests. Typecheck and build are clean.
2. DEMO shows simulated checks only, with no network call that includes a screen.
3. REAL LOCAL (manual, on your PC): "Open Notepad and type hello". Close Notepad mid-run → the check reports off_track → the plan adapts to reopen Notepad → the task finishes. The timeline shows the change.
4. A replan that needs an unapproved key stops the task with the stated message. Nothing extra runs.
5. Stop during a check halts everything immediately.

Real-PC items (3 and 5) can only be confirmed by you. I will report them as unverified until you run them.
