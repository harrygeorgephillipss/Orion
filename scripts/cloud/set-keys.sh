#!/usr/bin/env bash
# Add or change Aura's API keys on the ORION server, then restart the backend. Keys are typed here (hidden) and
# stored only in /opt/orion/.env (root-only). Run:  sudo bash /opt/orion/scripts/cloud/set-keys.sh
set -euo pipefail
DIR=${ORION_DIR:-/opt/orion}
ENV="$DIR/.env"
[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }
[ -f "$ENV" ] || { echo "$ENV not found - run the installer first."; exit 1; }
setenv() {
  python3 - "$ENV" "$1" "$2" <<'PY'
import sys, re
p, k, v = sys.argv[1:]
lines = open(p).read().splitlines()
hit = False
for i, l in enumerate(lines):
    if re.match(rf"^{re.escape(k)}=", l):
        lines[i] = f"{k}={v}"; hit = True
if not hit:
    lines.append(f"{k}={v}")
open(p, "w").write("\n".join(lines) + "\n")
PY
}
cur() { grep -s "^$1=." "$ENV" >/dev/null && echo "set" || echo "not set"; }
echo "Aura (Claude) key: $(cur ANTHROPIC_API_KEY)   Google voice key: $(cur GOOGLE_CLOUD_API_KEY)"
echo "Press Enter at any question to keep what is there."
read -r -s -p "Anthropic API key (hidden): " K </dev/tty; echo
if [ -n "$K" ]; then
  read -r -p "Claude model ID [claude-sonnet-5-5]: " M </dev/tty; M=${M:-claude-sonnet-5-5}
  setenv ANTHROPIC_API_KEY "$K"; setenv AURA_MODEL "$M"; setenv AURA_PROVIDER anthropic
fi
read -r -s -p "Google Cloud API key for voice (hidden): " G </dev/tty; echo
if [ -n "$G" ]; then setenv GOOGLE_CLOUD_API_KEY "$G"; setenv VOICE_STT_PROVIDER google; setenv VOICE_TTS_PROVIDER google; fi
chmod 600 "$ENV"
cd "$DIR"
docker compose --profile https -f deployment/docker-compose.yml --env-file .env up -d backend >/dev/null
echo "Restarted the backend. Checking Aura in a few seconds..."
sleep 8
docker compose -f deployment/docker-compose.yml --env-file .env exec -T backend python - <<'PY'
from app.aura.providers import get_provider
from app.aura import voice
p = get_provider()
print("Aura AI   :", "Claude (" + p.model + ")" if p and hasattr(p, "model") else ("on" if p else "OFF - basic mode (no key or model)"))
print("Voice in  :", voice.stt().name if voice.stt() else "device speech recognition (no Google key)")
print("Voice out :", voice.tts().name if voice.tts() else "device voice (no Google key)")
PY
