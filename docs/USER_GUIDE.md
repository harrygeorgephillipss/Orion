# Using the ORION app

The same app runs in a browser (served by your ORION server) and on Android (the APK). Everything below works in both.

## First-time setup (owner)

1. Start the server ([BACKEND.md](BACKEND.md)). Your first account comes from `ORION_BOOTSTRAP_OWNER_EMAIL` /
   `ORION_BOOTSTRAP_OWNER_PASSWORD` in the server's `.env`.
2. Open the server address in a browser — or, in the Android app, type the address on the first screen and tap
   **Connect** — then **Sign in**.
3. **Settings → Registered devices → Register a gateway**: keep the suggested ids, tap Register. Enter the server's
   address on your home network and **copy the setup code**. Flash the ESP32 once (no editing needed), power it,
   join its Wi-Fi **ORION-Setup-…** (password `orion-setup`), and on the page that opens enter your home Wi-Fi and
   paste the code. Lost the code or moving house? **New setup code** on the device row, then hold the ESP32's BOOT
   button for 5 s to reopen its setup page.
4. **Settings → Emergency contacts**: add the people who should get SMS/calls. The gateway receives the list
   automatically and keeps it, so alerts work even without internet.
5. **Settings → People**: add family members. Roles: *viewer* (see only), *member* (acknowledge alerts, fan and
   buzzer test), *admin* (devices, contacts, people, settings), *owner* (everything).
6. On each phone: install the APK, enter the server address, sign in, allow notifications.

## Everyday use

| Page | What you do there |
|---|---|
| **Home** | Overall state (All good / Needs attention / Emergency / Partly offline / Offline), every sensor with its age, active alerts |
| **History** | Charts per sensor (hour → week), alert bands, gaps where no data arrived, CSV export |
| **Alerts** | Every incident with its timeline and what the devices did; **Mark as seen** (it does not silence or end the alert) |
| **Devices** | Outputs as commanded, boards, SMS/call attempts, fan on/off and buzzer test (member+) |
| **Aura** | Ask in your language by text or voice; Aura checks ORION data, opens pages and can *suggest* a fan/buzzer command that you confirm |
| **Settings** | Your password and phone notifications; contacts, people, devices, activity log (admins); app settings |

Labels to know: **simulated** = not from hardware · **Last known / Not updating** = stale, not current ·
**Done · unconfirmed** = the controller did it but nothing confirms it physically · **Sent** (SMS) = the modem
accepted it, not that it was delivered.

**In a real fire or gas leak, don't use the app — get everyone out and call 112 (or 101 for fire).**
