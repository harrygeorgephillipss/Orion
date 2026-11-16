"""Keeps the Mosquitto password file in step with registered gateways (optional: ORION_MQTT_PASSWD_FILE).

The broker container watches this file and reloads within a few seconds (deployment/docker-compose.yml), so
registering or removing a gateway in the app needs no manual broker step. Entries are PBKDF2-SHA512 hashes in
Mosquitto 2's `$7$` format — the file never holds a plain password.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import logging
import os
import secrets
from pathlib import Path

from ..config import get_settings

log = logging.getLogger("orion.broker")
ITER = 101


def entry(user: str, password: str) -> str:
    salt = secrets.token_bytes(12)
    dk = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, ITER)
    return f"{user}:$7${ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def _path() -> Path | None:
    p = get_settings().mqtt_passwd_file
    return Path(p) if p else None


def _rewrite(user: str, new_line: str | None) -> bool:
    path = _path()
    if path is None:
        return False
    if ":" in user or "\n" in user:
        raise ValueError("invalid broker user name")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lines = [l for l in (path.read_text().splitlines() if path.exists() else []) if l and not l.startswith(user + ":")]
        if new_line:
            lines.append(new_line)
        tmp = path.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + ("\n" if lines else ""))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    return True


def upsert(user: str, password: str) -> bool:
    try:
        return _rewrite(user, entry(user, password))
    except OSError as e:
        log.warning("could not update broker password file: %s", e)
        return False


def remove(user: str) -> bool:
    try:
        return _rewrite(user, None)
    except OSError as e:
        log.warning("could not update broker password file: %s", e)
        return False
