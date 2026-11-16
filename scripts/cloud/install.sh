#!/usr/bin/env bash
# ORION cloud server installer — fresh Ubuntu 22.04 / 24.04 server (any provider), run as root:
#
#   curl -fsSLo install.sh https://raw.githubusercontent.com/harrygeorgephillipss/Orion/dev/scripts/cloud/install.sh
#   sudo bash install.sh
#
# Installs Docker, downloads ORION to /opt/orion, creates .env (your owner account and optional API keys are typed
# here, on the server), opens the firewall (22, 80, 443, 8883), and starts ORION with HTTPS (Caddy + Let's Encrypt)
# and an encrypted broker port for the ESP32. Safe to run again: it keeps your .env and updates the files.
set -euo pipefail
DIR=/opt/orion
REPO=https://github.com/harrygeorgephillipss/Orion.git
say() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die() { printf '\n\033[33m%s\033[0m\n' "$*"; exit 1; }
ask() { local a; read -r -p "   $1 " a </dev/tty; printf '%s' "$a"; }
setenv() {  # replace KEY=... in .env, or append it
  local k=$1 v=$2
  if grep -q "^$k=" "$DIR/.env"; then
    python3 - "$DIR/.env" "$k" "$v" <<'EOF'
import sys, re
p, k, v = sys.argv[1:]
s = open(p).read().splitlines()
open(p, "w").write("\n".join(f"{k}={v}" if re.match(rf"^{re.escape(k)}=", l) else l for l in s) + "\n")
EOF
  else printf '%s=%s\n' "$k" "$v" >> "$DIR/.env"; fi
}

[ "$(id -u)" = 0 ] || die "Run with sudo:  sudo bash install.sh"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || info "Warning: written for Ubuntu (this is ${PRETTY_NAME:-unknown}); continuing."

say "1/6  Packages (Docker, Git, firewall)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl python3 ca-certificates openssl >/dev/null
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null
docker compose version >/dev/null || die "Docker Compose is missing. Install Docker from docs.docker.com and run this again."
info "$(docker --version)"
# small servers: add swap so building the backend doesn't run out of memory
if [ "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)" -lt 1900 ] && ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  info "Added 2 GB swap"
fi

say "2/6  ORION files"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only -q || info "Could not update; using the existing copy."
else git clone -q -b dev "$REPO" "$DIR"; fi
info "ORION is in $DIR"

say "3/6  Address"
IP=$(curl -fsS4 https://api.ipify.org || curl -fsS4 https://ifconfig.me || true)
[ -n "$IP" ] || die "Could not find this server's public IP address."
DEF="${IP//./-}.sslip.io"
DOMAIN=$(grep -s '^ORION_DOMAIN=.' "$DIR/.env" | cut -d= -f2 | cut -d' ' -f1 || true)
if [ -z "$DOMAIN" ]; then
  info "Public IP: $IP"
  info "Use your own domain (e.g. a free DuckDNS name pointing to $IP), or press Enter for $DEF"
  DOMAIN=$(ask "Domain [$DEF]:"); DOMAIN=${DOMAIN:-$DEF}
fi
RES=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)
[ "$RES" = "$IP" ] || die "$DOMAIN points to '${RES:-nothing}', not $IP. Fix the DNS record (wait a few minutes) and run this again."
info "App address: https://$DOMAIN"

say "4/6  Settings (.env)"
if [ ! -f "$DIR/.env" ]; then
  info "Choose the owner account you will sign in with (password: 10+ characters, upper and lower case and a digit)."
  (cd "$DIR" && python3 scripts/setup.py --server-url "https://$DOMAIN" </dev/tty)
  [ -f "$DIR/.env" ] || die "Settings were not created. Run this again."
  if [[ "$(ask 'Add your Anthropic API key so Aura uses Claude? (y/N):')" =~ ^[Yy] ]]; then
    read -r -s -p "   Anthropic API key (hidden): " K </dev/tty; echo
    M=$(ask "Claude model ID (from the Anthropic models page):")
    if [ -n "$K" ] && [ -n "$M" ]; then setenv ANTHROPIC_API_KEY "$K"; setenv AURA_MODEL "$M"; setenv AURA_PROVIDER anthropic; fi
  fi
  if [[ "$(ask 'Add a Google Cloud API key for Aura voice? (y/N):')" =~ ^[Yy] ]]; then
    read -r -s -p "   Google Cloud API key (hidden): " G </dev/tty; echo
    if [ -n "$G" ]; then setenv GOOGLE_CLOUD_API_KEY "$G"; setenv VOICE_STT_PROVIDER google; setenv VOICE_TTS_PROVIDER google; fi
  fi
else info ".env exists - keeping your secrets and keys."; fi
setenv ORION_DOMAIN "$DOMAIN"
setenv ORION_LAN_HOST "$DOMAIN"
setenv ORION_GATEWAY_MQTT_PORT 8883
setenv ORION_MQTT_PLAIN_BIND 127.0.0.1:1883
setenv ORION_MQTT_TLS_BIND 8883
chmod 600 "$DIR/.env"

say "5/6  Firewall"
if command -v netfilter-persistent >/dev/null || iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
  # Oracle Cloud images ship their own iptables rules (reject all but SSH) managed by netfilter-persistent; ufw
  # conflicts with that package, so open the ports in those rules instead.
  for p in 443 80 8883; do iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT; done
  netfilter-persistent save >/dev/null 2>&1 || true
  info "Opened 80, 443, 8883 in the image's iptables rules."
else
  apt-get install -y -qq ufw >/dev/null
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 8883/tcp >/dev/null
  ufw --force enable >/dev/null
  info "ufw: 22, 80, 443, 8883 open; everything else closed."
fi
info "ALSO open TCP 80, 443, 8883 in your provider's firewall (Oracle: VCN > Security List > Ingress Rules)."

say "6/6  Starting ORION (first build takes a few minutes)"
cd "$DIR"
docker compose --profile https -f deployment/docker-compose.yml --env-file .env up -d --build
ok=""
for _ in $(seq 1 60); do
  # checked on this server itself (some clouds can't reach their own public IP); proves the certificate is valid
  if curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/v1/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[ -n "$ok" ] || die "No HTTPS certificate yet. Let's Encrypt must reach this server on port 80: open TCP 80/443 in your provider's firewall (Oracle: Security List), then run this again. Details: docker compose -f deployment/docker-compose.yml logs caddy"
# the broker picks up Caddy's certificate on its next start
docker compose --profile https -f deployment/docker-compose.yml --env-file .env restart mqtt >/dev/null
sleep 3
if echo | timeout 8 openssl s_client -connect "127.0.0.1:8883" -servername "$DOMAIN" -verify_return_error >/dev/null 2>&1; then tls="ready"; else tls="not ready yet (it starts once the certificate exists; check again in a minute)"; fi

printf '\n\033[32m================ ORION is running ================\033[0m\n'
echo " Phone app / browser address :  https://$DOMAIN"
echo " ESP32 broker (encrypted)     :  $DOMAIN  port 8883  - $tls"
echo " Sign in with the owner email and password you chose."
echo " Starts automatically after a reboot. Logs: cd $DIR && docker compose -f deployment/docker-compose.yml logs -f"
echo "=================================================="
