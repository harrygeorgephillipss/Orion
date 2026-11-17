#!/usr/bin/env bash
# Creates the ORION server on Google Cloud and installs it. Run in Google Cloud Shell (console.cloud.google.com,
# the ">_" button, top right), in a project with billing enabled:
#
#   curl -fsSLo gcp.sh https://raw.githubusercontent.com/harrygeorgephillipss/Orion/dev/scripts/cloud/gcp-create.sh
#   bash gcp.sh
#
# Creates (free-tier sizes): VM "orion" (e2-micro, Ubuntu 24.04, 30 GB standard disk) in us-central1-a, a static IP
# "orion-ip", firewall rule "orion-ports" (TCP 80, 443, 8883 to VMs tagged "orion"). Then runs scripts/cloud/install.sh
# on the VM. Safe to run again: existing pieces are reused. Override the zone with: ZONE=us-west1-b bash gcp.sh
set -euo pipefail
ZONE=${ZONE:-us-central1-a}
REGION=${ZONE%-*}
URL=https://raw.githubusercontent.com/harrygeorgephillipss/Orion/dev/scripts/cloud/install.sh
say() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[33m%s\033[0m\n' "$*"; exit 1; }

PROJECT=$(gcloud config get-value project 2>/dev/null || true)
[ -n "$PROJECT" ] || die "No project selected. Pick your project in the console's top bar, then run this again."
say "Project: $PROJECT   Zone: $ZONE"

say "1/5  Enabling Compute Engine (first time takes a minute)"
gcloud services enable compute.googleapis.com || die "Could not enable Compute Engine. Link a billing account to this project (Menu > Billing), then run this again."

say "2/5  Static IP address"
gcloud compute addresses describe orion-ip --region "$REGION" >/dev/null 2>&1 || gcloud compute addresses create orion-ip --region "$REGION"
IP=$(gcloud compute addresses describe orion-ip --region "$REGION" --format='value(address)')
echo "   $IP"

say "3/5  Firewall (80, 443 for the app, 8883 for the ESP32)"
gcloud compute firewall-rules describe orion-ports >/dev/null 2>&1 || \
  gcloud compute firewall-rules create orion-ports --network default --direction INGRESS --allow tcp:80,tcp:443,tcp:8883 --source-ranges 0.0.0.0/0 --target-tags orion

say "4/5  Server"
if ! gcloud compute instances describe orion --zone "$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create orion --zone "$ZONE" --machine-type e2-micro \
    --image-family ubuntu-2404-lts-amd64 --image-project ubuntu-os-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard --tags orion --address "$IP"
fi
echo "   Waiting for it to boot..."
for _ in $(seq 1 30); do
  gcloud compute ssh orion --zone "$ZONE" --quiet --command true >/dev/null 2>&1 && break
  sleep 10
done

if [[ "$(read -r -p '   Also turn on Google speech for Aura voice and create a restricted API key? (y/N) ' a; echo "$a")" =~ ^[Yy] ]]; then
  gcloud services enable speech.googleapis.com texttospeech.googleapis.com apikeys.googleapis.com
  KEY=$(gcloud services api-keys create --display-name=orion-voice \
        --api-target=service=speech.googleapis.com --api-target=service=texttospeech.googleapis.com \
        --format='value(response.keyString)' 2>/dev/null || true)
  if [ -n "$KEY" ]; then
    printf '\n   Voice API key (paste it when the installer asks for the Google Cloud API key):\n   \033[32m%s\033[0m\n' "$KEY"
  else
    echo "   Could not create the key automatically: APIs & Services > Credentials > Create credentials > API key."
  fi
fi

say "5/5  Installing ORION on the server (questions follow; first build takes 10-15 minutes)"
gcloud compute ssh orion --zone "$ZONE" -- -t "curl -fsSLo install.sh $URL && sudo bash install.sh"

printf '\nDone. App address: https://%s.sslip.io (unless you chose your own domain).\n' "${IP//./-}"
echo "Set a budget alert: Menu > Billing > Budgets & alerts."
