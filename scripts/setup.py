#!/usr/bin/env python3
"""Create ORION's .env with strong random secrets.

  python3 scripts/setup.py                       # asks for the owner email and password
  python3 scripts/setup.py --email you@example.com --server-url https://orion.local

Refuses to overwrite an existing .env unless --force. The password is never echoed or written anywhere except
.env (which is git-ignored); the server hashes it when it creates the owner account on first start.
"""
from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def strong(pw: str) -> list[str]:
    errs = []
    if len(pw) < 10:
        errs.append("at least 10 characters")
    if pw.lower() == pw or pw.upper() == pw or not any(c.isdigit() for c in pw):
        errs.append("upper and lower case letters and a digit")
    return errs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email")
    ap.add_argument("--name", default="Owner")
    ap.add_argument("--server-url", default="", help="public address of the server, added to CORS with the Android app's origin")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--password-env", help="read the owner password from this environment variable (automation)")
    a = ap.parse_args()
    env = ROOT / ".env"
    if env.exists() and not a.force:
        sys.exit(".env already exists — use --force to replace it (this changes all secrets).")
    email = a.email or input("Owner email: ").strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        sys.exit("That doesn't look like an email address.")
    pw = os.environ.get(a.password_env, "") if a.password_env else getpass.getpass("Owner password: ")
    if not a.password_env and pw != getpass.getpass("Repeat: "):
        sys.exit("Passwords differ.")
    if errs := strong(pw):
        sys.exit("Password needs " + " and ".join(errs) + ".")
    origins = ",".join(x for x in [a.server_url.rstrip("/"), "https://localhost"] if x)
    pg, mq = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    values = {
        "ORION_ENV": "production",
        "ORION_SECRET_KEY": secrets.token_hex(32),
        "ORION_CORS_ORIGINS": origins,
        "ORION_BOOTSTRAP_OWNER_EMAIL": email,
        "ORION_BOOTSTRAP_OWNER_PASSWORD": pw,
        "ORION_BOOTSTRAP_OWNER_NAME": a.name,
        "POSTGRES_USER": "orion", "POSTGRES_PASSWORD": pg, "POSTGRES_DB": "orion",
        "ORION_DATABASE_URL": f"postgresql+asyncpg://orion:{pg}@localhost:5432/orion",
        "ORION_MQTT_USERNAME": "orion-backend", "ORION_MQTT_PASSWORD": mq,
    }
    out = []
    for line in (ROOT / ".env.example").read_text().splitlines():
        m = re.match(r"^([A-Z_]+)=", line)
        if m and m.group(1) in values:
            line = f"{m.group(1)}={values.pop(m.group(1))}"
        out.append(line)
    out += [f"{k}={v}" for k, v in values.items()]
    env.write_text("\n".join(out) + "\n")
    try:
        os.chmod(env, 0o600)
    except OSError:  # e.g. a Windows folder mounted into Docker
        pass
    print(f"Wrote {env} (permissions 600). Next:")
    print("  docker compose -f deployment/docker-compose.yml --env-file .env up -d --build")
    print("Then open the server, sign in as", email, "and follow docs/USER_GUIDE.md.")


if __name__ == "__main__":
    main()
