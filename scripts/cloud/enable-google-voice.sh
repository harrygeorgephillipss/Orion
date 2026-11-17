#!/usr/bin/env bash
# Turn on Google speech for Aura on a Google Cloud VM, using the VM's own identity (no key stored anywhere).
# Before: enable "Cloud Speech-to-Text API" and "Cloud Text-to-Speech API" in the project, and give the VM
# "Allow full access to all Cloud APIs" (docs/VOICE.md).   Run:  sudo bash /opt/orion/scripts/cloud/enable-google-voice.sh
set -uo pipefail
DIR=${ORION_DIR:-/opt/orion}; ENV="$DIR/.env"
[ "$(id -u)" = 0 ] || { echo "Run with sudo:  sudo bash $0"; exit 1; }
MD=http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default
scopes=$(curl -fsS -m 5 -H "Metadata-Flavor: Google" "$MD/scopes" 2>/dev/null) || { echo "This is not a Google Cloud VM. Use a Google API key or service-account file instead (docs/VOICE.md)."; exit 1; }
if ! grep -q -e "auth/cloud-platform" <<<"$scopes"; then
  echo "The VM is not allowed to use Google Cloud APIs yet. In the console:"
  echo "  Compute Engine > VM instances > orion > STOP, then EDIT > Access scopes >"
  echo "  'Allow full access to all Cloud APIs' > SAVE > START. Then run this again."
  exit 1
fi
echo "VM identity: $(curl -fsS -m 5 -H 'Metadata-Flavor: Google' "$MD/email")  (scopes OK)"
setenv() { python3 - "$ENV" "$1" "$2" <<'PY'
import sys, re
p, k, v = sys.argv[1:]
lines = open(p).read().splitlines(); hit = False
for i, l in enumerate(lines):
    if re.match(rf"^{re.escape(k)}=", l): lines[i] = f"{k}={v}"; hit = True
if not hit: lines.append(f"{k}={v}")
open(p, "w").write("\n".join(lines) + "\n")
PY
}
setenv VOICE_GOOGLE_AUTH metadata; setenv VOICE_STT_PROVIDER google; setenv VOICE_TTS_PROVIDER google
chmod 600 "$ENV"; cd "$DIR"
docker compose --profile https -f deployment/docker-compose.yml --env-file .env up -d backend >/dev/null
echo "Restarted the backend. Testing Google speech..."; sleep 8
docker compose -f deployment/docker-compose.yml --env-file .env exec -T backend python - <<'PY'
import asyncio, io, wave
from app.aura import voice as V
def hint(e):
    m = str(e)
    if "SERVICE_DISABLED" in m or "403" in m and "PERMISSION" not in m: return " -> enable the API in APIs & Services > Library"
    if "PERMISSION_DENIED" in m or "SCOPE" in m: return " -> check the VM access scope and that the VM's service account has the Editor role"
    return ""
async def main():
    try:
        audio, _ = await V.tts().synthesize("Hello, I am Aura.", "en", "", 1.0)
        print("Speech out (Text-to-Speech):", "WORKS" if audio[:3] == b"ID3" or len(audio) > 100 else "unexpected reply")
    except V.VoiceError as e:
        print("Speech out (Text-to-Speech): FAILED -", e, hint(e))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 8000)
    try:
        await V.stt().transcribe(buf.getvalue(), "audio/wav", "en")
        print("Speech in  (Speech-to-Text): WORKS")
    except V.VoiceError as e:
        print("Speech in  (Speech-to-Text):", "WORKS (silence test)" if e.code == "no_speech" else f"FAILED - {e}{hint(e)}")
asyncio.run(main())
PY
