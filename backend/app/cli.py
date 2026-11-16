"""Admin CLI: `python -m app.cli create-user EMAIL NAME ROLE` (password read from the terminal, never argv)."""
from __future__ import annotations

import argparse
import asyncio
import getpass
import sys

from sqlalchemy import select

from .audit import audit
from .db import sessionmaker
from .models import Role, User
from .security import hash_password, password_problems


async def create_user(email: str, name: str, role: str, password: str) -> None:
    async with sessionmaker()() as db:
        if (await db.execute(select(User).where(User.email == email.lower()))).scalars().first():
            sys.exit("A user with that email already exists")
        db.add(User(email=email.lower(), name=name, role=Role(role), password_hash=hash_password(password)))
        audit(db, "system", "cli", "user.create", email.lower(), {"role": role})
        await db.commit()
    print(f"Created {role} {email}")


def main() -> None:
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("email")
    c.add_argument("name")
    c.add_argument("role", choices=[r.value for r in Role])
    a = p.parse_args()
    if a.cmd == "create-user":
        pw = getpass.getpass("Password: ")
        if pw != getpass.getpass("Repeat: "):
            sys.exit("Passwords differ")
        if probs := password_problems(pw):
            sys.exit(" ".join(probs))
        asyncio.run(create_user(a.email, a.name, a.role, pw))


if __name__ == "__main__":
    main()
