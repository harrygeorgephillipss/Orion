#!/bin/sh
# Broker entrypoint: the ORION server maintains /run/orion-auth/passwd (gateway accounts, PBKDF2 hashes).
# Copy it in with the broker's own owner, start Mosquitto, and reload (SIGHUP) whenever the file changes.
set -eu
AUTH=/run/orion-auth/passwd
mkdir -p /run/orion-auth
chown 10001 /run/orion-auth          # the backend container's user writes here
chmod 0700 /run/orion-auth
copy() {
  if [ -s "$AUTH" ]; then install -o mosquitto -g mosquitto -m 600 "$AUTH" /mosquitto/config/passwd
  else install -o mosquitto -g mosquitto -m 600 /dev/null /mosquitto/config/passwd; fi
}
sum() { md5sum "$AUTH" 2>/dev/null | cut -d' ' -f1 || true; }
copy
/docker-entrypoint.sh /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
pid=$!
last=$(sum)
trap 'kill -TERM $pid 2>/dev/null; wait $pid; exit 0' TERM INT
while kill -0 "$pid" 2>/dev/null; do
  sleep 3
  now=$(sum)
  if [ "$now" != "$last" ]; then last=$now; copy; kill -HUP "$pid"; fi
done
wait "$pid"
