"""FastAPI app. Bound to 127.0.0.1 only (see __main__). Endpoints:

GET  /health        public basics; authenticated details when a valid token is sent
POST /pair          exchange the console pairing code for a session token
GET  /capabilities  (auth) supported actions, keys and limits
POST /observe       (auth) capture a screenshot, returns an observation_id
POST /actions       (auth) execute ONE validated action
POST /cancel        (auth) cancel a task; further actions for it are rejected
POST /stop          (allowed origin, no token) stop accepting actions, interrupt current one
POST /resume        (auth) accept actions again
"""
from __future__ import annotations

import asyncio
import base64
import logging
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from . import NAME, VERSION
from .actions import ALLOWED_KEYS, MAX_TEXT, ActionEnvelope, ActionInterrupted, Executor, run_action
from .config import WorkerConfig
from .security import PairingCode, TokenAuthority

log = logging.getLogger("desktoppilot.worker")
MAX_BODY = 16 * 1024
MAX_OBSERVATIONS = 20
MAX_CANCELLED = 200


@dataclass
class Observation:
    width: int
    height: int
    at: float


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PairBody(_Strict):
    code: str = Field(min_length=4, max_length=16)


class ObserveBody(_Strict):
    task_id: Optional[str] = Field(default=None, max_length=64)


class CancelBody(_Strict):
    task_id: str = Field(min_length=1, max_length=64)


class WorkerState:
    def __init__(self) -> None:
        self.stopped = False
        self.lock = asyncio.Lock()
        self.observations: dict[str, Observation] = {}
        self.cancelled: deque[str] = deque(maxlen=MAX_CANCELLED)
        self.current_task: Optional[str] = None
        self.interrupt = threading.Event()
        self.auth_failures: deque[float] = deque()


def create_app(config: WorkerConfig, authority: TokenAuthority, pairing: PairingCode, executor: Executor, clock=time.time) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    st = WorkerState()
    app.state.worker = st
    hosts = {f"127.0.0.1:{config.port}", f"localhost:{config.port}"}
    origins = set(config.allowed_origins)

    def cors(origin: Optional[str]) -> dict[str, str]:
        h = {"Vary": "Origin"}
        if origin:
            h["Access-Control-Allow-Origin"] = origin
        return h

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # DNS-rebinding defence: only accept loopback Host headers.
        if request.headers.get("host", "") not in hosts:
            return JSONResponse({"detail": "invalid_host"}, status_code=403)
        origin = request.headers.get("origin")
        if origin is not None and origin not in origins:
            log.warning("Rejected request from non-allowlisted origin %s", origin[:100])
            return JSONResponse({"detail": "origin_not_allowed"}, status_code=403)
        try:
            if int(request.headers.get("content-length", "0")) > MAX_BODY:
                return JSONResponse({"detail": "body_too_large"}, status_code=413, headers=cors(origin))
        except ValueError:
            return JSONResponse({"detail": "bad_content_length"}, status_code=400)
        if request.method == "OPTIONS":
            h = {
                **cors(origin),
                "Access-Control-Allow-Methods": "GET, POST",
                "Access-Control-Allow-Headers": "Authorization, Content-Type",
                "Access-Control-Max-Age": "600",
            }
            # Chrome Private/Local Network Access preflight
            if request.headers.get("access-control-request-private-network") == "true":
                h["Access-Control-Allow-Private-Network"] = "true"
            return Response(status_code=204, headers=h)
        resp = await call_next(request)
        for k, v in cors(origin).items():
            resp.headers[k] = v
        resp.headers["Cache-Control"] = "no-store"
        log.info("%s %s -> %s", request.method, request.url.path, resp.status_code)
        return resp

    @app.exception_handler(RequestValidationError)
    async def _invalid(_req: Request, exc: RequestValidationError):
        # Never echo request input (may contain typed text) back or into logs.
        errs = [{"loc": [str(x) for x in e.get("loc", [])], "msg": e.get("msg", "")} for e in exc.errors()]
        return JSONResponse({"detail": "invalid_request", "errors": errs}, status_code=422)

    def require_auth(request: Request) -> None:
        now = clock()
        while st.auth_failures and now - st.auth_failures[0] > 60:
            st.auth_failures.popleft()
        if len(st.auth_failures) >= 20:
            raise HTTPException(429, "too_many_auth_failures")
        h = request.headers.get("authorization", "")
        if not h.startswith("Bearer ") or not authority.verify(h[7:].strip()):
            st.auth_failures.append(now)
            raise HTTPException(401, "unauthorized")

    def screen() -> Optional[dict]:
        try:
            w, h = executor.screen_size()
            return {"width": w, "height": h}
        except Exception:  # noqa: BLE001
            return None

    def ensure_can_act(task_id: Optional[str]) -> None:
        if st.stopped:
            raise HTTPException(423, "worker_stopped")
        if task_id and task_id in st.cancelled:
            raise HTTPException(409, "task_cancelled")
        if st.lock.locked():
            raise HTTPException(409, "busy")

    @app.get("/health")
    async def health(request: Request):
        body = {"ok": True, "name": NAME, "version": VERSION, "authenticated": False, "pairing_available": pairing.active}
        if request.headers.get("authorization"):
            try:
                require_auth(request)
            except HTTPException as e:
                if e.status_code == 429:
                    raise
                body["auth_error"] = "invalid_or_expired_token"
                return body
            body.update(authenticated=True, busy=st.lock.locked(), stopped=st.stopped, screen=screen())
        return body

    @app.post("/pair")
    async def pair(body: PairBody):
        if not pairing.consume(body.code):
            raise HTTPException(401, "invalid_or_expired_pairing_code")
        token, exp = authority.issue()
        log.info("Dashboard paired; session token issued")
        return {"token": token, "expires_at": exp}

    @app.get("/capabilities")
    async def capabilities(request: Request):
        require_auth(request)
        return {
            "actions": ["observe", "launch_app", "click", "type_text", "key_press", "copy_selection", "paste", "wait", "stop"],
            "keys": sorted(ALLOWED_KEYS),
            "limits": {
                "max_text": MAX_TEXT,
                "max_wait_ms": 10000,
                "action_timeout_s": config.action_timeout_s,
                "max_observation_age_s": config.max_observation_age_s,
                "max_concurrent_actions": 1,
            },
            "ui_automation": False,
            "screen": screen(),
        }

    @app.post("/observe")
    async def observe(request: Request, body: ObserveBody):
        require_auth(request)
        ensure_can_act(body.task_id)
        async with st.lock:
            try:
                img, sw, sh, iw, ih = await asyncio.wait_for(asyncio.to_thread(executor.screenshot), config.observe_timeout_s)
            except asyncio.TimeoutError:
                raise HTTPException(504, "observe_timeout")
            except Exception as e:  # noqa: BLE001
                log.error("Screenshot failed: %s", type(e).__name__)
                raise HTTPException(500, f"screenshot_failed:{type(e).__name__}")
        oid = secrets.token_urlsafe(12)
        st.observations[oid] = Observation(sw, sh, clock())
        while len(st.observations) > MAX_OBSERVATIONS:
            st.observations.pop(next(iter(st.observations)))
        return {
            "observation_id": oid,
            "width": sw,
            "height": sh,
            "image_width": iw,
            "image_height": ih,
            "captured_at": int(clock() * 1000),
            "image": "data:image/jpeg;base64," + base64.b64encode(img).decode(),
        }

    @app.post("/actions")
    async def actions(request: Request, env: ActionEnvelope):
        require_auth(request)
        ensure_can_act(env.task_id)
        a = env.action
        if a.kind == "click":
            obs = st.observations.get(a.observation_id)
            if obs is None:
                raise HTTPException(409, "observation_required")
            if clock() - obs.at > config.max_observation_age_s:
                raise HTTPException(409, "observation_stale")
            cur = screen()
            if cur is None or (cur["width"], cur["height"]) != (obs.width, obs.height):
                raise HTTPException(409, "screen_changed")
            if a.x >= obs.width or a.y >= obs.height:
                raise HTTPException(422, "coordinates_out_of_bounds")
        async with st.lock:
            st.current_task = env.task_id
            st.interrupt.clear()

            def should_stop() -> bool:
                return st.stopped or st.interrupt.is_set() or env.task_id in st.cancelled

            try:
                result = await asyncio.wait_for(asyncio.to_thread(run_action, executor, a, should_stop), config.action_timeout_s)
            except asyncio.TimeoutError:
                st.interrupt.set()
                raise HTTPException(504, "action_timeout")
            except ActionInterrupted:
                raise HTTPException(409, "interrupted")
            except Exception as e:  # noqa: BLE001
                if type(e).__name__ == "FailSafeException":
                    st.stopped = True
                    raise HTTPException(423, "failsafe_triggered")
                log.error("Action %s failed: %s", a.kind, type(e).__name__)
                raise HTTPException(500, f"action_failed:{type(e).__name__}")
            finally:
                st.current_task = None
        log.info("Action %s completed for task %s", a.kind, env.task_id[:64])
        return {"ok": True, "request_id": env.request_id, "kind": a.kind, "completed_at": int(clock() * 1000), **result}

    @app.post("/cancel")
    async def cancel(request: Request, body: CancelBody):
        require_auth(request)
        st.cancelled.append(body.task_id)
        if st.current_task == body.task_id:
            st.interrupt.set()
        return {"cancelled": body.task_id}

    @app.post("/stop")
    async def stop():
        st.stopped = True
        st.interrupt.set()
        log.warning("STOP received — no further actions will run until resumed")
        return {"stopped": True}

    @app.post("/resume")
    async def resume(request: Request):
        require_auth(request)
        st.stopped = False
        st.interrupt.clear()
        return {"stopped": False}

    return app
