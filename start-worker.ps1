# start-worker.ps1 — start the DesktopPilot desktop helper with one command.
# Usage (PowerShell, from the project root):
#   .\start-worker.ps1
# It creates the Python environment on first run, installs dependencies,
# frees port 8765 from a previous helper instance, and starts the helper.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir = Join-Path $root "worker\visual-agent"
$py = Join-Path $dir ".venv\Scripts\python.exe"

# 1. Config file
if (-not (Test-Path (Join-Path $dir "config.json"))) {
    Write-Host "Creating config.json from config.example.json..."
    Copy-Item (Join-Path $dir "config.example.json") (Join-Path $dir "config.json")
}

# 2. Python virtual environment + dependencies (first run only)
if (-not (Test-Path $py)) {
    Write-Host "Creating the Python environment (first run, a minute or two)..."
    py -3 -m venv (Join-Path $dir ".venv")
    & $py -m pip install --upgrade pip
}
$marker = Join-Path $dir ".venv\.deps-installed"
if (-not (Test-Path $marker)) {
    Write-Host "Installing dependencies (first run only)..."
    & $py -m pip install -r (Join-Path $dir "requirements.txt")
    New-Item -ItemType File -Path $marker -Force | Out-Null
}

# 3. Free the port from a previous helper instance (kills ONLY python processes)
$cfg = Get-Content (Join-Path $dir "config.json") | ConvertFrom-Json
$port = [int]$cfg.port
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -like "*python*") {
        Write-Host "Stopping the previous helper (PID $($proc.Id)) so the port is free..."
        Stop-Process -Id $proc.Id -Force
    } else {
        $name = if ($proc) { $proc.ProcessName } else { "unknown" }
        Write-Error "Port $port is used by another program ($name, PID $($c.OwningProcess)). Close it or change 'port' in worker\visual-agent\config.json."
        exit 1
    }
}

# 4. One-time signing key (safe to re-run; does nothing if it already exists)
& $py -m desktoppilot_worker setup

# 5. Run the helper (Ctrl+C to stop)
& $py -m desktoppilot_worker run --config config.json
