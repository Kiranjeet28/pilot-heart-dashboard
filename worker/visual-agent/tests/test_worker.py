import logging
import threading
import time

import pytest
from fastapi.testclient import TestClient

from desktoppilot_worker.actions import ActionInterrupted
from desktoppilot_worker.config import ConfigError, from_dict
from desktoppilot_worker.security import PairingCode, RedactingFilter, TokenAuthority, redact
from desktoppilot_worker.server import create_app

ORIGIN = "https://dash.example.com"
KEY = "k" * 43


class FakeExecutor:
    def __init__(self):
        self.calls = []
        self.size = (1920, 1080)
        self.clipboard = ""
        self.block = threading.Event()

    def screen_size(self):
        return self.size

    def screenshot(self):
        return b"\xff\xd8fake", self.size[0], self.size[1], 1600, 900

    def click(self, x, y):
        self.calls.append(("click", x, y))

    def type_text(self, text, should_stop):
        for _ in text:
            if should_stop():
                raise ActionInterrupted()
        self.calls.append(("type", len(text)))
        self.clipboard = text

    def press(self, keys):
        self.calls.append(("press", keys))

    def copy_selection(self):
        return self.clipboard

    def paste(self, text):
        self.calls.append(("paste", text))

    def wait(self, ms, should_stop):
        end = time.monotonic() + ms / 1000
        while time.monotonic() < end:
            if should_stop():
                raise ActionInterrupted()
            time.sleep(0.01)


@pytest.fixture
def env():
    cfg = from_dict({"port": 8765, "allowed_origins": [ORIGIN]})
    ex = FakeExecutor()
    pairing = PairingCode()
    app = create_app(cfg, TokenAuthority(KEY, 3600), pairing, ex)
    client = TestClient(app, base_url="http://127.0.0.1:8765", headers={"Origin": ORIGIN})
    return client, ex, pairing


def pair(client, pairing):
    r = client.post("/pair", json={"code": pairing.display})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def act(client, auth, action, task="t1"):
    return client.post("/actions", headers=auth, json={"request_id": "r1", "task_id": task, "action": action})


def test_config_rejects_wildcard_and_other_hosts():
    with pytest.raises(ConfigError):
        from_dict({"allowed_origins": ["*"]})
    with pytest.raises(ConfigError):
        from_dict({"allowed_origins": [ORIGIN], "host": "0.0.0.0"})


def test_rejects_foreign_host_and_origin(env):
    client, _, _ = env
    assert client.get("/health", headers={"Host": "evil.com:8765"}).status_code == 403
    assert client.get("/health", headers={"Origin": "https://evil.com"}).status_code == 403


def test_preflight_allows_private_network(env):
    client, _, _ = env
    r = client.options("/observe", headers={"Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true"})
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == ORIGIN
    assert r.headers["access-control-allow-private-network"] == "true"


def test_health_unauthenticated_vs_authenticated(env):
    client, _, pairing = env
    assert client.get("/health").json()["authenticated"] is False
    auth = pair(client, pairing)
    body = client.get("/health", headers=auth).json()
    assert body["authenticated"] is True and body["screen"] == {"width": 1920, "height": 1080}


def test_pairing_code_single_use_and_bad_code(env):
    client, _, pairing = env
    assert client.post("/pair", json={"code": "WRONG-CODE"}).status_code == 401
    pair(client, pairing)
    assert client.post("/pair", json={"code": pairing.display}).status_code == 401


def test_endpoints_require_auth(env):
    client, _, _ = env
    assert client.post("/observe", json={}).status_code == 401
    assert act(client, {}, {"kind": "wait", "duration_ms": 1}).status_code == 401
    assert client.post("/observe", json={}, headers={"Authorization": "Bearer v1.9999999999.x.y"}).status_code == 401


def test_rejects_non_allowlisted_actions(env):
    client, _, pairing = env
    auth = pair(client, pairing)
    assert act(client, auth, {"kind": "shell", "cmd": "dir"}).status_code == 422
    assert act(client, auth, {"kind": "key_press", "keys": "alt+f4"}).status_code == 422
    assert act(client, auth, {"kind": "type_text", "text": "bad\x07"}).status_code == 422
    assert act(client, auth, {"kind": "wait", "duration_ms": 60000}).status_code == 422


def test_click_requires_fresh_observation_and_bounds(env):
    client, ex, pairing = env
    auth = pair(client, pairing)
    assert act(client, auth, {"kind": "click", "x": 5, "y": 5, "observation_id": "missing-id"}).status_code == 409
    oid = client.post("/observe", headers=auth, json={}).json()["observation_id"]
    assert act(client, auth, {"kind": "click", "x": 1920, "y": 5, "observation_id": oid}).status_code == 422
    assert act(client, auth, {"kind": "click", "x": 100, "y": 200, "observation_id": oid}).status_code == 200
    ex.size = (1280, 720)
    assert act(client, auth, {"kind": "click", "x": 100, "y": 200, "observation_id": oid}).json()["detail"] == "screen_changed"


def test_copy_returns_length_not_content(env):
    client, _, pairing = env
    auth = pair(client, pairing)
    act(client, auth, {"kind": "type_text", "text": "DesktopPilot test 123"})
    body = act(client, auth, {"kind": "copy_selection"}).json()
    assert body["clipboard_length"] == 21 and "DesktopPilot" not in str(body)


def test_stop_blocks_new_actions_until_resume(env):
    client, ex, pairing = env
    auth = pair(client, pairing)
    assert client.post("/stop").status_code == 200  # no token needed for stop
    assert act(client, auth, {"kind": "key_press", "keys": "enter"}).status_code == 423
    assert ("press", "enter") not in ex.calls
    client.post("/resume", headers=auth)
    assert act(client, auth, {"kind": "key_press", "keys": "enter"}).status_code == 200


def test_stop_interrupts_running_action(env):
    client, _, pairing = env
    auth = pair(client, pairing)
    result = {}
    t = threading.Thread(target=lambda: result.setdefault("r", act(client, auth, {"kind": "wait", "duration_ms": 5000})))
    t.start()
    time.sleep(0.3)
    client.post("/stop")
    t.join(timeout=3)
    assert result["r"].status_code == 409 and result["r"].json()["detail"] == "interrupted"


def test_cancelled_task_rejected(env):
    client, _, pairing = env
    auth = pair(client, pairing)
    client.post("/cancel", headers=auth, json={"task_id": "t9"})
    assert act(client, auth, {"kind": "key_press", "keys": "enter"}, task="t9").json()["detail"] == "task_cancelled"


def test_validation_error_does_not_echo_input(env):
    client, _, pairing = env
    auth = pair(client, pairing)
    r = act(client, auth, {"kind": "type_text", "text": "secret-ish\x01"})
    assert "secret-ish" not in r.text


def test_token_expiry():
    now = [1000.0]
    a = TokenAuthority(KEY, 10, clock=lambda: now[0])
    tok, _ = a.issue()
    assert a.verify(tok)
    now[0] += 11
    assert not a.verify(tok)
    assert not TokenAuthority("z" * 43, 10, clock=lambda: 1000.0).verify(tok)


def test_log_redaction(caplog):
    tok, _ = TokenAuthority(KEY, 100).issue()
    assert tok not in redact(f"Authorization: Bearer {tok}")
    assert tok not in redact(f"token={tok}")
    logger = logging.getLogger("t")
    logger.addFilter(RedactingFilter())
    with caplog.at_level(logging.INFO):
        logger.info("got %s", tok)
    assert tok not in caplog.text
