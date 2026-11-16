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
# TLS (cloud): reuse Caddy's certificate for ORION_DOMAIN. Mosquitto must restart to add or renew a listener's
# certificate, so the loop below exits when it changes and Docker restarts the container.
D=${ORION_DOMAIN:-}
mkdir -p /run/orion-tls/conf /run/orion-tls/cert
rm -f /run/orion-tls/conf/*
certsrc() { [ -n "$D" ] && find /caddy-data/caddy/certificates -path "*/$D/$D.crt" 2>/dev/null | head -n1 || true; }
certsum() { c=$(certsrc); [ -n "$c" ] && md5sum "$c" | cut -d' ' -f1 || true; }
crt=$(certsrc)
if [ -n "$crt" ] && [ -s "${crt%.crt}.key" ]; then
  install -o mosquitto -g mosquitto -m 644 "$crt" /run/orion-tls/cert/server.crt
  install -o mosquitto -g mosquitto -m 600 "${crt%.crt}.key" /run/orion-tls/cert/server.key
  printf 'listener 8883 0.0.0.0\ncertfile /run/orion-tls/cert/server.crt\nkeyfile /run/orion-tls/cert/server.key\ntls_version tlsv1.2\n' > /run/orion-tls/conf/tls.conf
  echo "orion: TLS listener on 8883 for $D"
fi
lastcert=$(certsum)
/docker-entrypoint.sh /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
pid=$!
last=$(sum)
trap 'kill -TERM $pid 2>/dev/null; wait $pid; exit 0' TERM INT
while kill -0 "$pid" 2>/dev/null; do
  sleep 3
  now=$(sum)
  if [ "$now" != "$last" ]; then last=$now; copy; kill -HUP "$pid"; fi
  if [ "$(certsum)" != "$lastcert" ]; then echo "orion: certificate changed, restarting broker"; kill -TERM "$pid"; wait "$pid"; exit 0; fi
done
wait "$pid"
