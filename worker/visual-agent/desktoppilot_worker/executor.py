"""Real desktop executor using PyAutoGUI + pyperclip. Imported lazily so tests run without a display.

Windows UI Automation (pywinauto / uiautomation) is a planned later extension for
window focusing and element targeting; it is intentionally not implemented here.
"""
from __future__ import annotations

import io
import secrets
import time
from typing import Callable, Optional

from .actions import ActionInterrupted


class PyAutoGuiExecutor:
    def __init__(self, max_image_width: int = 1600):
        import pyautogui  # noqa: WPS433 (lazy import)
        import pyperclip

        pyautogui.FAILSAFE = True  # slam the mouse into a screen corner to abort
        pyautogui.PAUSE = 0.05
        self.pg = pyautogui
        self.clip = pyperclip
        self.max_w = max_image_width

    def screen_size(self) -> tuple[int, int]:
        w, h = self.pg.size()
        return int(w), int(h)

    def screenshot(self) -> tuple[bytes, int, int, int, int]:
        sw, sh = self.screen_size()
        img = self.pg.screenshot().convert("RGB")
        if img.width > self.max_w:
            ratio = self.max_w / img.width
            img = img.resize((self.max_w, int(img.height * ratio)))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return buf.getvalue(), sw, sh, img.width, img.height

    def click(self, x: int, y: int) -> None:
        self.pg.click(x=x, y=y, button="left")

    def type_text(self, text: str, should_stop: Callable[[], bool]) -> None:
        for ch in text:
            if should_stop():
                raise ActionInterrupted()
            if ch == "\n":
                self.pg.press("enter")
            else:
                self.pg.write(ch)
            time.sleep(0.01)

    def press(self, keys: str) -> None:
        # PyAutoGUI names the Windows key "win".
        parts = ["win" if p == "windows" else p for p in keys.split("+")]
        if len(parts) == 1:
            self.pg.press(parts[0])
        else:
            self.pg.hotkey(*parts)

    def copy_selection(self) -> str:
        sentinel = f"__desktoppilot_{secrets.token_hex(4)}__"
        self.clip.copy(sentinel)
        self.pg.hotkey("ctrl", "c")
        time.sleep(0.3)
        text = self.clip.paste()
        return "" if text == sentinel else text

    def paste(self, text: Optional[str]) -> None:
        if text is not None:
            self.clip.copy(text)
        self.pg.hotkey("ctrl", "v")

    def wait(self, ms: int, should_stop: Callable[[], bool]) -> None:
        end = time.monotonic() + ms / 1000
        while time.monotonic() < end:
            if should_stop():
                raise ActionInterrupted()
            time.sleep(0.05)
