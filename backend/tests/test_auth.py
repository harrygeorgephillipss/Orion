from __future__ import annotations

from app.models import Role
from tests.conftest import PASSWORD, login, make_user


async def test_login_me_and_web_refresh_cookie(client, users):
    r = await client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": PASSWORD})
    assert r.status_code == 200
    body = r.json()
    assert "refresh_token" not in body, "web clients must not receive the refresh token in JS-readable JSON"
    assert "orion_refresh" in r.cookies
    assert "httponly" in r.headers["set-cookie"].lower()
    me = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"})
    assert me.json()["role"] == "owner"
    r2 = await client.post("/api/v1/auth/refresh", json={})
    assert r2.status_code == 200 and r2.json()["access_token"]


async def test_refresh_rotation_and_reuse_detection(client, users):
    tok = (await login(client, "member@example.com", "mobile"))["refresh_token"]
    r1 = await client.post("/api/v1/auth/refresh", json={"refresh_token": tok, "client": "mobile"})
    assert r1.status_code == 200
    new = r1.json()["refresh_token"]
    assert new != tok
    reuse = await client.post("/api/v1/auth/refresh", json={"refresh_token": tok, "client": "mobile"})
    assert reuse.status_code == 401 and "reuse" in reuse.json()["detail"]
    # the whole family is revoked, including the newest token
    after = await client.post("/api/v1/auth/refresh", json={"refresh_token": new, "client": "mobile"})
    assert after.status_code == 401


async def test_logout_revokes_refresh(client, users):
    tok = (await login(client, "viewer@example.com", "mobile"))["refresh_token"]
    assert (await client.post("/api/v1/auth/logout", json={"refresh_token": tok})).status_code == 200
    assert (await client.post("/api/v1/auth/refresh", json={"refresh_token": tok, "client": "mobile"})).status_code == 401


async def test_wrong_password_and_lockout(client, db):
    await make_user(db, "x@example.com", Role.member)
    for _ in range(5):
        r = await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": "nope"})
        assert r.status_code == 401
    r = await client.post("/api/v1/auth/login", json={"email": "x@example.com", "password": PASSWORD})
    assert r.status_code == 429, "account locked after repeated failures"


async def test_unknown_user_same_error(client):
    r = await client.post("/api/v1/auth/login", json={"email": "ghost@example.com", "password": "whatever"})
    assert r.status_code == 401 and r.json()["detail"] == "Wrong email or password"


async def test_login_rate_limit(client):
    codes = [(await client.post("/api/v1/auth/login", json={"email": "a@example.com", "password": "x"})).status_code for _ in range(12)]
    assert 429 in codes


async def test_protected_endpoints_require_token(client):
    for path in ["/api/v1/overview", "/api/v1/incidents", "/api/v1/devices", "/api/v1/config"]:
        assert (await client.get(path)).status_code == 401
    assert (await client.get("/api/v1/overview", headers={"Authorization": "Bearer junk"})).status_code == 401


async def test_rbac(client, auth):
    assert (await client.post("/api/v1/commands", json={"actuator": "fan", "action": "on"}, headers=auth["viewer"])).status_code == 403
    assert (await client.post("/api/v1/devices/gateways", json={"id": "gw-x"}, headers=auth["member"])).status_code == 403
    assert (await client.get("/api/v1/audit", headers=auth["member"])).status_code == 403
    assert (await client.get("/api/v1/audit", headers=auth["admin"])).status_code == 200
    # admin cannot create an owner, and cannot create a peer admin
    r = await client.post("/api/v1/users", json={"email": "n@example.com", "name": "N", "password": PASSWORD, "role": "admin"}, headers=auth["admin"])
    assert r.status_code == 403
    r = await client.post("/api/v1/users", json={"email": "n@example.com", "name": "N", "password": PASSWORD, "role": "member"}, headers=auth["admin"])
    assert r.status_code == 201


async def test_password_policy(client, auth):
    r = await client.post("/api/v1/users", json={"email": "w@example.com", "name": "W", "password": "short", "role": "viewer"}, headers=auth["owner"])
    assert r.status_code == 422


async def test_security_headers_and_health(client):
    r = await client.get("/api/v1/health")
    assert r.status_code == 200 and r.json()["database"] is True
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"


async def test_admin_cannot_escalate_or_manage_peers(client, auth, users):
    member_id, admin_id = users["member"].id, users["admin"].id
    # promote a member to admin → refused
    r = await client.patch(f"/api/v1/users/{member_id}", json={"role": "admin"}, headers=auth["admin"])
    assert r.status_code == 403
    # disable another admin → refused
    from tests.conftest import make_user
    from app.db import sessionmaker
    async with sessionmaker()() as db:
        other = await make_user(db, "admin2@example.com", Role.admin)
        other_id = other.id
    assert (await client.patch(f"/api/v1/users/{other_id}", json={"is_active": False}, headers=auth["admin"])).status_code == 403
    # owner can do both
    assert (await client.patch(f"/api/v1/users/{member_id}", json={"role": "admin"}, headers=auth["owner"])).status_code == 200
    # admin may still manage lower roles
    assert (await client.patch(f"/api/v1/users/{users['viewer'].id}", json={"role": "member"}, headers=auth["admin"])).status_code == 200
    assert admin_id


async def test_password_change_and_disable_revoke_sessions(client, users, auth):
    tok = (await login(client, "member@example.com", "mobile"))["refresh_token"]
    access = (await login(client, "member@example.com"))["access_token"]
    r = await client.post("/api/v1/users/me/password", json={"current_password": PASSWORD, "new_password": "Brand-New-Pass-7"}, headers={"Authorization": f"Bearer {access}"})
    assert r.status_code == 200
    assert (await client.post("/api/v1/auth/refresh", json={"refresh_token": tok, "client": "mobile"})).status_code == 401
    tok2 = (await login(client, "viewer@example.com", "mobile"))["refresh_token"]
    assert (await client.patch(f"/api/v1/users/{users['viewer'].id}", json={"is_active": False}, headers=auth["owner"])).status_code == 200
    assert (await client.post("/api/v1/auth/refresh", json={"refresh_token": tok2, "client": "mobile"})).status_code == 401
    assert (await client.get("/api/v1/auth/me", headers=auth["viewer"])).status_code == 401, "disabled user's access token stops working"


async def test_home_timezone_validated(client, auth):
    assert (await client.put("/api/v1/config/home", json={"name": "H", "timezone": "Mars/Base"}, headers=auth["admin"])).status_code == 422
    assert (await client.put("/api/v1/config/home", json={"name": "H", "timezone": "Asia/Kolkata"}, headers=auth["admin"])).status_code == 200
