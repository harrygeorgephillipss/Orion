# Running ORION on a cloud server

One small Linux server on the internet runs everything. The phone app connects over HTTPS from anywhere; the ESP32
connects over an encrypted MQTT link (TLS, port 8883). The UNO/ESP32 keep protecting the home if the server or the
internet is down.

## 1. Create the server

Any provider with a plain Ubuntu server works, for example Hetzner Cloud, DigitalOcean, or the Oracle Cloud free tier.

- Image **Ubuntu 24.04** (or 22.04), **2 GB RAM** recommended (1 GB works: the installer adds swap), 20 GB disk.
- Allow SSH login (password or SSH key). Note the server's **public IP address**.
- If the provider has its own firewall, open TCP **22, 80, 443, 8883**.

### Oracle Cloud Always Free

1. Compute → Instances → **Create instance**. Image: **Canonical Ubuntu 24.04**. Shape: **Ampere VM.Standard.A1.Flex**
   (1–2 OCPU, 6–12 GB, Always Free) — or VM.Standard.E2.1.Micro if Ampere says "out of capacity" (try another
   availability domain or later first). Networking: create a new VCN with a **public subnet** and **assign a public
   IPv4 address**. SSH keys: **Save private key**.
2. Instance page → subnet → **Security List** → **Add Ingress Rules**: source `0.0.0.0/0`, TCP, destination ports
   `80,443,8883`.
3. Connect: `ssh -i <downloaded-key> ubuntu@<public-ip>` (Windows PowerShell works; if it complains about key
   permissions, move the key to `C:\Users\<you>\.ssh\`).
4. Oracle may reclaim Always Free instances that stay idle for a week; upgrading the account to Pay-As-You-Go
   (still free within the Always Free limits) avoids that. The installer opens the ports in Oracle's own iptables
   rules; the Security List step above is still needed.

The backend's Python packages all have ready-made Arm (aarch64) builds, so Ampere works.

### Google Cloud in one command

In the console open **Cloud Shell** (`>_`, top right) in a project with billing, then run
`curl -fsSLo gcp.sh https://raw.githubusercontent.com/harrygeorgephillipss/Orion/dev/scripts/cloud/gcp-create.sh && bash gcp.sh`.
It creates the e2-micro VM, static IP and firewall rule, optionally a restricted voice API key, and runs the installer.

## 2. Optional: your own name

The installer can use a free automatic name, `<ip-with-dashes>.sslip.io`. A name you control is more robust:
for example a free DuckDNS name (`yourname.duckdns.org`) with its IP set to the server's IP.

## 3. Install

Connect with SSH (`ssh root@<server-ip>`, or the provider's web console) and run:

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/harrygeorgephillipss/Orion/dev/scripts/cloud/install.sh
```

```bash
sudo bash install.sh
```

It asks for the domain (Enter = sslip.io name), the owner email and password, and optionally your Anthropic key +
Claude model ID and a Google Cloud API key. Keys are typed only on the server and stored in `/opt/orion/.env`
(root only). At the end it prints the **app address** and the **ESP32 broker address**.

## 4. Use it

- Phone app: enter `https://<your domain>` and sign in.
- ESP32: register the gateway in the app (Settings → Registered devices); the setup code already contains the cloud
  address and port 8883, and the firmware then uses TLS automatically, checking the server's Let's Encrypt
  certificate (`hardware/esp32/src/le_roots.h`).

## What the installer sets up

| Piece | Detail |
|---|---|
| Docker + Compose | ORION runs as containers that restart automatically after a reboot |
| Caddy | HTTPS for the app with an automatically renewed certificate |
| Mosquitto | TLS listener on 8883 using the same certificate (restarts itself when it renews); plain 1883 only on 127.0.0.1 |
| Firewall (ufw) | 22, 80, 443, 8883 open; everything else closed |
| Swap | 2 GB if the server has less than 2 GB RAM |

## Maintenance

```bash
cd /opt/orion && git pull && docker compose --profile https -f deployment/docker-compose.yml --env-file .env up -d --build
```

Backup: `docker compose -f deployment/docker-compose.yml exec db pg_dump -U orion orion > backup.sql`.
Logs: `docker compose -f deployment/docker-compose.yml logs -f backend`.

## Tested / not tested

Tested here: the broker's TLS listener with a stand-in certificate (TLS 1.3 handshake, restart on renewal, home mode
without TLS unchanged), the Compose configuration, the ESP32 firmware build with TLS, the script's syntax.
**Not tested yet:** the installer on a real cloud server, a real Let's Encrypt certificate, and an ESP32 connecting
over TLS. If Let's Encrypt is unavailable Caddy may use ZeroSSL instead; the ESP32 only trusts Let's Encrypt roots,
so its connection would then fail until `MQTT_CA_CERT` is set at build time.
