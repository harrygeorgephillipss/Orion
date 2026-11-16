# Runs at Windows sign-in (task "ORION server", created by install-orion.ps1).
# Starts Docker Desktop if needed, then the ORION containers and the Tailscale public address. Log: ..\..\orion-start.log
param([string]$Dir = (Resolve-Path "$PSScriptRoot\..\..").Path)
$log = "$Dir\orion-start.log"
function Log($m) { Add-Content -Path $log -Value "$(Get-Date -Format s)  $m" }
if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Remove-Item $log }

$docker = (Get-Command docker -ErrorAction SilentlyContinue).Source
if (-not $docker) { $docker = "$env:ProgramFiles\Docker\Docker\resources\bin\docker.exe" }
$DD = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
if (-not (Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue) -and (Test-Path $DD)) { Start-Process $DD; Log 'started Docker Desktop' }

$ok = $false
for ($i = 0; $i -lt 60; $i++) { & $docker info *> $null; if ($LASTEXITCODE -eq 0) { $ok = $true; break }; Start-Sleep 5 }
if (-not $ok) { Log 'Docker did not start within 5 minutes'; exit 1 }

& $docker compose -f "$Dir\deployment\docker-compose.yml" --env-file "$Dir\.env" up -d 2>&1 | ForEach-Object { Log "$_" }
$ts = "$env:ProgramFiles\Tailscale\tailscale.exe"
if (Test-Path $ts) { & $ts funnel --bg 8000 2>&1 | ForEach-Object { Log "$_" } }
Log 'ORION start finished'
