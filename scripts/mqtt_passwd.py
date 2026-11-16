#!/usr/bin/env python3
"""Add or replace a user in a Mosquitto password file (PBKDF2-SHA512, Mosquitto 2.x `$7$` format).

  python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd esp32-01        # prompts for the password
  python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd orion-backend --from-env ORION_MQTT_PASSWORD

Use the gateway password returned ONCE by POST /api/v1/devices/gateways. Then restart (or SIGHUP) Mosquitto.
The passwd file holds hashes only, but keep it out of git (it is in .gitignore).
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import os
import secrets
import sys
from pathlib import Path

ITER = 101  # Mosquitto's default for $7$


def entry(user: str, password: str) -> str:
    salt = secrets.token_bytes(12)
    dk = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, ITER)
    return f"{user}:$7${ITER}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("file")
    p.add_argument("user")
    p.add_argument("--from-env", help="read the password from this environment variable")
    a = p.parse_args()
    if ":" in a.user or not a.user:
        sys.exit("invalid user name")
    pw = os.environ.get(a.from_env, "") if a.from_env else getpass.getpass(f"Password for {a.user}: ")
    if len(pw) < 12:
        sys.exit("password too short (min 12 characters)")
    path = Path(a.file)
    lines = [l for l in (path.read_text().splitlines() if path.exists() else []) if l and not l.startswith(a.user + ":")]
    lines.append(entry(a.user, pw))
    path.write_text("\n".join(lines) + "\n")
    os.chmod(path, 0o600)
    print(f"{a.user} written to {path}")


if __name__ == "__main__":
    main()
