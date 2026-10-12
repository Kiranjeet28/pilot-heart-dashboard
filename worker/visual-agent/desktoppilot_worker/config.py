"""Worker configuration. The bind host is fixed to 127.0.0.1 and cannot be configured."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

BIND_HOST = "127.0.0.1"  # never 0.0.0.0
DEFAULT_PORT = 8765

_ORIGIN_RE = re.compile(r"^(https://[a-z0-9.-]+(:\d+)?|http://(localhost|127\.0\.0\.1)(:\d+)?)$")


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class WorkerConfig:
    port: int = DEFAULT_PORT
    allowed_origins: tuple[str, ...] = field(default_factory=tuple)
    session_ttl_hours: int = 12
    action_timeout_s: float = 15.0
    observe_timeout_s: float = 10.0
    max_observation_age_s: int = 60
    max_image_width: int = 1600
    log_file: str | None = None


def validate_origin(origin: str) -> str:
    o = origin.strip().rstrip("/")
    if o in ("*", "null") or not _ORIGIN_RE.match(o):
        raise ConfigError(
            f"Invalid allowed origin {origin!r}. Use an exact https:// origin, or http://localhost:<port> for local development."
        )
    return o


def from_dict(d: dict) -> WorkerConfig:
    unknown = set(d) - {f for f in WorkerConfig.__dataclass_fields__} - {"$comment", "host"}
    if unknown:
        raise ConfigError(f"Unknown config keys: {sorted(unknown)}")
    if "host" in d and d["host"] != BIND_HOST:
        raise ConfigError("host is fixed to 127.0.0.1; the worker never listens on other interfaces")
    port = int(d.get("port", DEFAULT_PORT))
    if not 1024 <= port <= 65535:
        raise ConfigError("port must be between 1024 and 65535")
    origins = tuple(validate_origin(o) for o in d.get("allowed_origins", []))
    if not origins:
        raise ConfigError("allowed_origins must list at least one dashboard origin")
    ttl = int(d.get("session_ttl_hours", 12))
    if not 1 <= ttl <= 72:
        raise ConfigError("session_ttl_hours must be 1-72")
    return WorkerConfig(
        port=port,
        allowed_origins=origins,
        session_ttl_hours=ttl,
        action_timeout_s=min(float(d.get("action_timeout_s", 15)), 30.0),
        observe_timeout_s=min(float(d.get("observe_timeout_s", 10)), 30.0),
        max_observation_age_s=min(int(d.get("max_observation_age_s", 60)), 300),
        max_image_width=max(640, min(int(d.get("max_image_width", 1600)), 3840)),
        log_file=d.get("log_file"),
    )


def load_config(path: str | Path) -> WorkerConfig:
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}. Copy config.example.json to config.json first.")
    return from_dict(json.loads(p.read_text(encoding="utf-8")))
