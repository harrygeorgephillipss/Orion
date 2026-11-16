# ORION home server setup for a Windows 10/11 laptop.
#
# What it does (safe to run again; it skips what is already done):
#   1. installs Git, Docker Desktop and Tailscale (winget)
#   2. downloads ORION into %USERPROFILE%\ORION
#   3. creates .env with strong random secrets (asks for your owner email/password and optional API keys here,
#      on this laptop - nothing is sent anywhere else)
#   4. starts ORION (database, broker, backend, Aura) in Docker
#   5. gives it a free public HTTPS address with Tailscale Funnel (for the phone app)
#   6. lets the ESP32 reach the broker on your home Wi-Fi (firewall rule, private network)
#   7. starts ORION automatically every time you sign in to Windows
#   8. optionally keeps the laptop awake while it is plugged in
#
# Run (PowerShell):  powershell -ExecutionPolicy Bypass -File install-orion.ps1
param([string]$Dir = "$env:USERPROFILE\ORION")

# 'Continue': Windows PowerShell 5.1 turns a program's error output into script errors under 'Stop';
# every program call below is checked with $LASTEXITCODE instead.
$ErrorActionPreference = 'Continue'
$Repo = 'https://github.com/harrygeorgephillipss/Orion.git'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Info($t) { Write-Host "   $t" }
function Warn($t) { Write-Host "   $t" -ForegroundColor Yellow }
function Ask($q, $def = 'Y') { $a = Read-Host "   $q [$def]"; if (-not $a) { $a = $def }; return ($a -match '^[Yy]') }
function Done($msg) { Write-Host "`n$msg" -ForegroundColor Yellow; Read-Host 'Press Enter to close'; exit 1 }
function RefreshPath { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Plain($s) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }

# --- administrator rights (needed for installs, firewall and power settings) ---
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Dir `"$Dir`""
  exit
}
$User = $env:USERNAME

Step '1/8  Programs (Git, Docker Desktop, Tailscale)'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Done 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.' }
$pkgs = @(
  @{ id = 'Git.Git'; test = { Get-Command git -ErrorAction SilentlyContinue } },
  @{ id = 'Docker.DockerDesktop'; test = { Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe" } },
  @{ id = 'Tailscale.Tailscale'; test = { Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe" } }
)
$installedDocker = $false
foreach ($p in $pkgs) {
  if (& $p.test) { Info "$($p.id) is installed"; continue }
  Info "Installing $($p.id) ..."
  winget install -e --id $p.id --silent --accept-package-agreements --accept-source-agreements
  if ($p.id -eq 'Docker.DockerDesktop') { $installedDocker = $true }
  RefreshPath
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Done 'Git did not install. Restart Windows and run this again.' }
$TS = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (-not (Test-Path $TS)) { Done 'Tailscale did not install. Restart Windows and run this again.' }
if ($installedDocker) { Done 'Docker Desktop was installed. RESTART Windows now, then run this script again to continue.' }

Step '2/8  Docker'
$DD = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { $env:Path += ";$env:ProgramFiles\Docker\Docker\resources\bin" }
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Info 'Starting Docker Desktop. If it shows a licence or survey window, accept/skip it.'
  Start-Process $DD
  $ok = $false
  for ($i = 0; $i -lt 120; $i++) { Start-Sleep 5; docker info *> $null; if ($LASTEXITCODE -eq 0) { $ok = $true; break } }
  if (-not $ok) { Done 'Docker did not start in 10 minutes. Open Docker Desktop, fix what it shows (often: restart Windows or enable WSL), then run this again.' }
}
Info 'Docker is running'

Step '3/8  ORION files'
if (Test-Path "$Dir\.git") {
  git -C $Dir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Warn 'Could not update the files (local changes?). Using the existing copy.' }
} else {
  git -c core.autocrlf=false clone -b dev $Repo $Dir
  if ($LASTEXITCODE -ne 0) { Done 'Download failed. Check the internet connection and run this again.' }
}
git -C $Dir config core.autocrlf false
Info "ORION is in $Dir"

Step '4/8  Tailscale (free public address for the app)'
$st = & $TS status --json 2>$null | Out-String | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $st -or $st.BackendState -ne 'Running') {
  Info 'A browser window opens: sign in (or create a free Tailscale account) and approve this laptop.'
  & $TS up
  $st = & $TS status --json | Out-String | ConvertFrom-Json
}
$Name = $st.Self.DNSName.TrimEnd('.')
if (-not $Name) { Done 'Tailscale is not signed in. Run this again.' }
$Url = "https://$Name"
Info "App address will be: $Url"

$lan = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
$LanIp = if ($lan) { $lan.IPv4Address[0].IPAddress } else { '' }
Info "Home network address of this laptop: $LanIp"

Step '5/8  Settings (.env)'
$Env = "$Dir\.env"
function SetEnv($k, $v) {
  $lines = [IO.File]::ReadAllLines($Env); $found = $false
  $out = foreach ($l in $lines) { if ($l -match "^$k=") { $found = $true; "$k=$v" } else { $l } }
  if (-not $found) { $out = @($out) + "$k=$v" }
  [IO.File]::WriteAllText($Env, (($out -join "`n") + "`n"))
}
if (-not (Test-Path $Env)) {
  Info 'Choose the owner account you will sign in with (password: 10+ characters, upper and lower case and a digit).'
  docker run --rm -it -v "${Dir}:/w" -w /w python:3.12-alpine python scripts/setup.py --server-url $Url
  if (-not (Test-Path $Env)) { Done 'Settings were not created. Run this again.' }
  if (Ask 'Add your Anthropic API key now so Aura uses Claude? (y/n)') {
    $k = Plain (Read-Host '   Anthropic API key (hidden)' -AsSecureString)
    $m = Read-Host '   Claude model ID to use (from the Anthropic models page)'
    if ($k -and $m) { SetEnv 'ANTHROPIC_API_KEY' $k; SetEnv 'AURA_MODEL' $m; SetEnv 'AURA_PROVIDER' 'anthropic' }
  }
  if (Ask 'Add a Google Cloud API key for Aura voice (Speech-to-Text + Text-to-Speech)? (y/n)' 'N') {
    $g = Plain (Read-Host '   Google Cloud API key (hidden)' -AsSecureString)
    if ($g) { SetEnv 'GOOGLE_CLOUD_API_KEY' $g; SetEnv 'VOICE_STT_PROVIDER' 'google'; SetEnv 'VOICE_TTS_PROVIDER' 'google' }
  }
} else { Info '.env already exists - keeping your secrets and keys.' }
if ($LanIp) { SetEnv 'ORION_LAN_HOST' $LanIp }
# only this Windows account may read the secrets file
icacls $Env /inheritance:r /grant:r "${User}:(R,W)" "SYSTEM:(F)" "Administrators:(F)" *> $null

Step '6/8  Starting ORION'
docker compose -f "$Dir\deployment\docker-compose.yml" --env-file $Env up -d --build
if ($LASTEXITCODE -ne 0) { Done 'ORION did not start. Run this again; if it repeats, send the messages above to your developer.' }
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  try { $h = Invoke-RestMethod -UseBasicParsing http://127.0.0.1:8000/api/v1/health -TimeoutSec 5 -ErrorAction Stop; if ($h.status) { $ok = $true; break } } catch { }
  Start-Sleep 3
}
if (-not $ok) { Done 'The ORION server did not answer. Check: docker compose -f deployment\docker-compose.yml logs backend' }
Info "Server is up (database: $($h.database), broker: $($h.mqtt))"

Info 'Turning on the public address. If Tailscale shows a link to enable Funnel/HTTPS, open it and allow it.'
& $TS funnel --bg 8000
$pub = $false
for ($i = 0; $i -lt 20; $i++) {
  try { $h2 = Invoke-RestMethod -UseBasicParsing "$Url/api/v1/health" -TimeoutSec 10 -ErrorAction Stop; if ($h2.status) { $pub = $true; break } } catch { }
  Start-Sleep 6
}
if ($pub) { Info "Public address works: $Url" } else { Warn "Public address not answering yet (the certificate can take a few minutes). Try $Url/api/v1/health in a browser later." }

Step '7/8  ESP32 access on home Wi-Fi + start with Windows'
$prof = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' } | Select-Object -First 1
if ($prof -and $prof.NetworkCategory -eq 'Public') {
  if (Ask "Your network '$($prof.Name)' is set to Public. Set it to Private (needed for the ESP32; only do this at home)? (y/n)") {
    Set-NetConnectionProfile -InterfaceIndex $prof.InterfaceIndex -NetworkCategory Private
  }
}
if (-not (Get-NetFirewallRule -DisplayName 'ORION broker (home network)' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'ORION broker (home network)' -Direction Inbound -Protocol TCP -LocalPort 1883 -Action Allow -Profile Private | Out-Null
}
Info 'Firewall: ESP32 may connect on port 1883 (private networks only)'
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\scripts\windows\start-orion.ps1`""
$trg = New-ScheduledTaskTrigger -AtLogOn -User $User
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'ORION server' -Action $act -Trigger $trg -Settings $set -Description 'Starts Docker Desktop and the ORION server at sign-in' -Force | Out-Null
Info 'ORION will start by itself each time you sign in (task "ORION server")'

Step '8/8  Sleep settings'
if (Ask 'Keep the laptop awake while it is plugged in, even with the lid closed? Recommended. (y/n)') {
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setactive SCHEME_CURRENT
  Info 'On charger: never sleeps, lid close does nothing. On battery: unchanged.'
} else { Info 'Unchanged. ORION pauses while the laptop sleeps and resumes when it wakes.' }

Write-Host "`n================ ORION is ready ================" -ForegroundColor Green
Write-Host " Phone app / browser address :  $Url"
Write-Host " ESP32 broker (home Wi-Fi)    :  $LanIp  port 1883"
Write-Host " Sign in with the owner email and password you chose."
Write-Host " Tip: in your router, reserve $LanIp for this laptop so the ESP32 always finds it."
Write-Host "================================================"
Read-Host 'Press Enter to close'
