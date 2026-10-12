"""Pairing, session tokens, protected key storage, and log redaction.

Design:
* `setup` generates a 256-bit signing key and stores it in the OS credential store
  (Windows Credential Manager via `keyring`). It is never printed or written to disk.
* Each `run` prints a short one-time pairing code to the console (not to logs).
* The dashboard exchanges the code at POST /pair for a session token:
  "v1.<expiry>.<nonce>.<hmac-sha256>" signed with the key. Tokens expire (default 12h).
* `setup --force` rotates the key, which invalidates every issued token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
from typing import Callable

KEYRING_SERVICE = "DesktopPilot Worker"
KEYRING_USER = "signing-key"
_PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class SecretStore:
    """Thin wrapper around keyring so tests can inject a fake."""

    def get(self) -> str | None:
        import keyring

        return keyring.get_password(KEYRING_SERVICE, KEYRING_USER)

    def set(self, value: str) -> None:
        import keyring

        keyring.set_password(KEYRING_SERVICE, KEYRING_USER, value)


def generate_signing_key() -> str:
    return secrets.token_urlsafe(32)


class TokenAuthority:
    def __init__(self, signing_key: str, ttl_seconds: int, clock: Callable[[], float] = time.time):
        if len(signing_key) < 32:
            raise ValueError("signing key too short")
        self._key = signing_key.encode()
        self._ttl = ttl_seconds
        self._clock = clock

    def _sig(self, payload: str) -> str:
        return _b64(hmac.new(self._key, payload.encode(), hashlib.sha256).digest())

    def issue(self) -> tuple[str, int]:
        exp = int(self._clock()) + self._ttl
        payload = f"v1.{exp}.{secrets.token_urlsafe(12)}"
        return f"{payload}.{self._sig(payload)}", exp

    def verify(self, token: str) -> bool:
        if not token or len(token) > 256:
            return False
        parts = token.split(".")
        if len(parts) != 4 or parts[0] != "v1" or not parts[1].isdigit():
            return False
        payload = ".".join(parts[:3])
        if not hmac.compare_digest(self._sig(payload), parts[3]):
            return False
        return int(parts[1]) > self._clock()


class PairingCode:
    """One-time code, valid for `ttl` seconds and at most `max_attempts` guesses."""

    def __init__(self, ttl: int = 300, max_attempts: int = 5, clock: Callable[[], float] = time.time):
        self._clock = clock
        raw = "".join(secrets.choice(_PAIR_ALPHABET) for _ in range(8))
        self.display = f"{raw[:4]}-{raw[4:]}"
        self._code = raw
        self._expires = clock() + ttl
        self._attempts = max_attempts

    @property
    def active(self) -> bool:
        return self._code != "" and self._attempts > 0 and self._clock() < self._expires

    def consume(self, candidate: str) -> bool:
        if not self.active:
            return False
        self._attempts -= 1
        norm = re.sub(r"[^A-Z0-9]", "", candidate.upper())
        if hmac.compare_digest(norm, self._code):
            self._code = ""  # single use
            return True
        return False


_REDACT = [
    (re.compile(r"Bearer\s+\S+", re.I), "Bearer [REDACTED]"),
    (re.compile(r"v1\.\d+\.[\w-]+\.[\w-]+"), "[REDACTED_TOKEN]"),
]


def redact(text: str) -> str:
    for pat, rep in _REDACT:
        text = pat.sub(rep, text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(str(record.getMessage()))
        record.args = ()
        return True
