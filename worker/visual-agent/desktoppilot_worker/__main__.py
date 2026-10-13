"""CLI: python -m desktoppilot_worker {setup,run}"""
from __future__ import annotations

import argparse
import logging
import socket
import sys

from . import NAME, VERSION
from .config import BIND_HOST, ConfigError, load_config
from .security import PairingCode, RedactingFilter, SecretStore, TokenAuthority, generate_signing_key


def _logging(log_file: str | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    for h in handlers:
        h.addFilter(RedactingFilter())
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=handlers, force=True)


def port_in_use(port: int) -> bool:
    """True when something already holds 127.0.0.1:<port> — e.g. a worker left running."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((BIND_HOST, port))
        except OSError:
            return True
    return False


def cmd_setup(force: bool) -> int:
    store = SecretStore()
    if store.get() and not force:
        print("A signing key already exists in Windows Credential Manager. Use --force to rotate it (re-pair afterwards).")
        return 0
    store.set(generate_signing_key())
    print("Signing key generated and stored in Windows Credential Manager (service: 'DesktopPilot Worker').")
    print("It is never printed or saved to disk. Next: python -m desktoppilot_worker run --config config.json")
    return 0


def cmd_run(config_path: str) -> int:
    try:
        cfg = load_config(config_path)
    except (ConfigError, ValueError) as e:
        print(f"Config error: {e}")
        return 2
    key = SecretStore().get()
    if not key:
        print("No signing key found. Run: python -m desktoppilot_worker setup")
        return 2
    _logging(cfg.log_file)
    try:
        from .executor import PyAutoGuiExecutor

        executor = PyAutoGuiExecutor(cfg.max_image_width)
    except Exception as e:  # noqa: BLE001
        print(f"Could not initialise desktop control ({type(e).__name__}: {e}). Run from a normal, unlocked Windows desktop session.")
        return 3

    import uvicorn

    from .server import create_app

    pairing = PairingCode()
    app = create_app(cfg, TokenAuthority(key, cfg.session_ttl_hours * 3600), pairing, executor)
    # Printed to the console only — never logged.
    print("=" * 60)
    print(f" {NAME} {VERSION}")
    print(f" Listening on http://{BIND_HOST}:{cfg.port} (local only)")
    print(f" Allowed dashboard origins: {', '.join(cfg.allowed_origins)}")
    print(f" PAIRING CODE: {pairing.display}   (single use, expires in 5 minutes)")
    print(" Emergency: Ctrl+C here, or move the mouse into a screen corner.")
    print("=" * 60)
    uvicorn.run(app, host=BIND_HOST, port=cfg.port, log_config=None, access_log=False, server_header=False)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(prog="desktoppilot_worker")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup", help="generate and store the signing key")
    s.add_argument("--force", action="store_true", help="rotate the key (invalidates all sessions)")
    r = sub.add_parser("run", help="start the local worker")
    r.add_argument("--config", default="config.json")
    a = p.parse_args()
    return cmd_setup(a.force) if a.cmd == "setup" else cmd_run(a.config)


if __name__ == "__main__":
    sys.exit(main())
