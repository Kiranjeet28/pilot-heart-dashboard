"""Strict, allowlisted action schema. Anything not matching is rejected with 422.

No shell, no Python eval, no file operations, no credential/cookie access.
Keep ALLOWED_KEYS in sync with src/lib/worker/key-allowlist.ts in the dashboard.
"""
from __future__ import annotations

import hashlib
from typing import Annotated, Callable, Literal, Optional, Protocol, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator

ALLOWED_KEYS = frozenset(
    {
        "enter", "tab", "escape", "backspace", "delete", "space",
        "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
        "ctrl+a", "ctrl+c", "ctrl+v", "ctrl+z", "shift+home", "shift+end",
        "windows", "windows+r", "windows+e", "windows+d",
    }
)
MAX_TEXT = 500


def _check_text(v: str) -> str:
    for ch in v:
        if ch == "\n":
            continue
        if not (32 <= ord(ch) <= 126):
            raise ValueError("text may only contain printable ASCII characters and newlines")
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ClickAction(_Strict):
    kind: Literal["click"]
    x: int = Field(ge=0, le=20000)
    y: int = Field(ge=0, le=20000)
    observation_id: str = Field(min_length=8, max_length=64)


class LaunchAppAction(_Strict):
    kind: Literal["launch_app"]
    app: Literal["notepad"]


class TypeTextAction(_Strict):
    kind: Literal["type_text"]
    text: str = Field(min_length=1, max_length=MAX_TEXT)
    _v = field_validator("text")(classmethod(lambda cls, v: _check_text(v)))


class KeyPressAction(_Strict):
    kind: Literal["key_press"]
    keys: str = Field(min_length=1, max_length=32)

    @field_validator("keys")
    @classmethod
    def _allow(cls, v: str) -> str:
        k = v.strip().lower()
        if k not in ALLOWED_KEYS:
            raise ValueError("key or shortcut is not on the allowlist")
        return k


class CopySelectionAction(_Strict):
    kind: Literal["copy_selection"]


class PasteAction(_Strict):
    kind: Literal["paste"]
    text: Optional[str] = Field(default=None, min_length=1, max_length=MAX_TEXT)

    @field_validator("text")
    @classmethod
    def _t(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else _check_text(v)


class WaitAction(_Strict):
    kind: Literal["wait"]
    duration_ms: int = Field(ge=0, le=10000)


Action = Annotated[
    Union[LaunchAppAction, ClickAction, TypeTextAction, KeyPressAction, CopySelectionAction, PasteAction, WaitAction],
    Field(discriminator="kind"),
]


class ActionEnvelope(_Strict):
    request_id: str = Field(min_length=1, max_length=64)
    task_id: str = Field(min_length=1, max_length=64)
    action: Action


class ActionInterrupted(Exception):
    """Raised when stop/cancel was accepted before or during an action."""


class Executor(Protocol):
    def launch_notepad(self) -> None: ...
    def screen_size(self) -> tuple[int, int]: ...
    def screenshot(self) -> tuple[bytes, int, int, int, int]: ...  # jpeg, screen w/h, image w/h
    def click(self, x: int, y: int) -> None: ...
    def type_text(self, text: str, should_stop: Callable[[], bool]) -> None: ...
    def press(self, keys: str) -> None: ...
    def copy_selection(self) -> str: ...
    def paste(self, text: Optional[str]) -> None: ...
    def wait(self, ms: int, should_stop: Callable[[], bool]) -> None: ...


def run_action(ex: Executor, a, should_stop: Callable[[], bool]) -> dict:
    if should_stop():
        raise ActionInterrupted()
    if a.kind == "launch_app":
        ex.launch_notepad()
        return {"message": "Launched approved Notepad application"}
    if a.kind == "click":
        ex.click(a.x, a.y)
        return {"message": f"Clicked at ({a.x}, {a.y})"}
    if a.kind == "type_text":
        ex.type_text(a.text, should_stop)
        return {"message": f"Typed {len(a.text)} characters", "typed_length": len(a.text)}
    if a.kind == "key_press":
        ex.press(a.keys)
        return {"message": f"Pressed {a.keys}"}
    if a.kind == "copy_selection":
        text = ex.copy_selection()
        # Clipboard content is never returned or logged — only its length and a short hash.
        return {
            "message": f"Copied {len(text)} characters",
            "clipboard_length": len(text),
            "clipboard_sha256_prefix": hashlib.sha256(text.encode()).hexdigest()[:12],
        }
    if a.kind == "paste":
        ex.paste(a.text)
        return {"message": "Pasted clipboard" if a.text is None else f"Pasted {len(a.text)} characters"}
    if a.kind == "wait":
        ex.wait(a.duration_ms, should_stop)
        return {"message": f"Waited {a.duration_ms} ms"}
    raise ValueError("unsupported action")
