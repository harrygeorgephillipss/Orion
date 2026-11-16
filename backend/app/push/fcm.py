"""FCM HTTP v1 sender.

Credentials: a Firebase service-account JSON file (FCM_SERVICE_ACCOUNT_FILE, kept outside the repo) and the project id
(FCM_PROJECT_ID). An OAuth access token is obtained by signing a JWT with the service account's private key.
Push is a convenience channel: ORION's local alarm and SMS never depend on it.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx
import jwt

from ..config import get_settings

log = logging.getLogger("orion.push")
SCOPE = "https://www.googleapis.com/auth/firebase.messaging"


class FcmClient:
    def __init__(self, project_id: str, service_account: dict, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.project_id = project_id
        self.sa = service_account
        self.http = httpx.AsyncClient(timeout=15, transport=transport)
        self._token: str | None = None
        self._exp = 0.0

    async def _access_token(self) -> str:
        if self._token and time.time() < self._exp - 60:
            return self._token
        now = int(time.time())
        assertion = jwt.encode(
            {"iss": self.sa["client_email"], "scope": SCOPE, "aud": self.sa.get("token_uri", "https://oauth2.googleapis.com/token"), "iat": now, "exp": now + 3600},
            self.sa["private_key"], algorithm="RS256",
        )
        r = await self.http.post(self.sa.get("token_uri", "https://oauth2.googleapis.com/token"), data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion})
        r.raise_for_status()
        j = r.json()
        self._token, self._exp = j["access_token"], time.time() + int(j.get("expires_in", 3600))
        return self._token

    async def send(self, token: str, title: str, body: str, data: dict[str, str], critical: bool) -> tuple[bool, str | None]:
        """Returns (ok, error). error == 'unregistered' means the token should be deleted."""
        msg = {"message": {
            "token": token,
            "notification": {"title": title, "body": body},
            "data": data,
            "android": {"priority": "HIGH", "ttl": "3600s", "notification": {"channel_id": "orion_emergency" if critical else "orion_alerts", "sound": "default"}},
        }}
        try:
            r = await self.http.post(f"https://fcm.googleapis.com/v1/projects/{self.project_id}/messages:send", headers={"Authorization": f"Bearer {await self._access_token()}"}, json=msg)
        except httpx.HTTPError as e:
            return False, f"network: {type(e).__name__}"
        if r.status_code == 200:
            return True, None
        status = ""
        try:
            status = r.json().get("error", {}).get("status", "")
        except ValueError:
            pass
        if r.status_code == 404 or status in ("NOT_FOUND", "UNREGISTERED"):
            return False, "unregistered"
        return False, f"{r.status_code} {status}"[:200]


def load_client() -> FcmClient | None:
    st = get_settings()
    if not (st.fcm_project_id and st.fcm_service_account_file):
        return None
    p = Path(st.fcm_service_account_file)
    if not p.is_file():
        log.warning("FCM_SERVICE_ACCOUNT_FILE %s not found — push disabled", p)
        return None
    return FcmClient(st.fcm_project_id, json.loads(p.read_text()))
