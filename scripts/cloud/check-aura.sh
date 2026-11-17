#!/usr/bin/env bash
# Checks Aura's connection to Claude from inside the ORION backend with one tiny request (costs a fraction of a cent).
# Prints only the key's type prefix, never the key.  Run:  sudo bash /opt/orion/scripts/cloud/check-aura.sh
set -uo pipefail
cd "${ORION_DIR:-/opt/orion}"
docker compose -f deployment/docker-compose.yml --env-file .env exec -T backend python - <<'PY'
import os
import anthropic
key, model = os.environ.get("ANTHROPIC_API_KEY", ""), os.environ.get("AURA_MODEL", "")
print("Key type  :", (key[:11] + "...") if key else "MISSING", "(an API key starts with sk-ant-api)")
print("Model     :", model or "MISSING")
try:
    r = anthropic.Anthropic(max_retries=0, timeout=30).messages.create(model=model, max_tokens=16, messages=[{"role": "user", "content": "Reply with: OK"}])
    print("Result    : WORKS -", "".join(b.text for b in r.content if b.type == "text") or r.stop_reason)
except anthropic.AuthenticationError:
    print("Result    : KEY REJECTED - create an API key at console.anthropic.com > API Keys, then run set-keys.sh")
except anthropic.PermissionDeniedError as e:
    print("Result    : NOT ALLOWED -", e.message[:200])
except anthropic.NotFoundError:
    print("Result    : MODEL NOT FOUND - run set-keys.sh and accept the default model")
except anthropic.BadRequestError as e:
    print("Result    : REQUEST REJECTED -", e.message[:200], "(no credit? check console.anthropic.com > Billing)")
except anthropic.RateLimitError:
    print("Result    : RATE LIMITED - wait a minute and try again")
except anthropic.APIStatusError as e:
    print("Result    : ERROR", e.status_code, "-", e.message[:200])
except anthropic.APIConnectionError:
    print("Result    : CANNOT REACH api.anthropic.com from the server (network/firewall)")
PY
