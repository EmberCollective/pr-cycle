param(
    [ValidateRange(1024, 65535)][int]$Port = 13680,
    [ValidateRange(1024, 65535)][int]$FrontendPort = 13681,
    [ValidateRange(1024, 65535)][int]$BackendPort = 13682,
    [string]$RuntimePath,
    [string]$TrackingDatabase,
    [switch]$BackendOnly
)
$ErrorActionPreference = 'Stop'
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
if (-not $RuntimePath) { $RuntimePath = Join-Path $repoRoot '.pr-cycle-runtime' }
$uiProcess = $null
$backendProcess = $null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source
if (-not $TrackingDatabase) { $TrackingDatabase = Join-Path $env:APPDATA 'bloop/vibe-kanban/data/db.sqlite' }
$TrackingDatabase = [IO.Path]::GetFullPath($TrackingDatabase)
$null = Get-Command npx.cmd -ErrorAction Stop
$apiHost = if ($BackendOnly) { '127.0.0.1' } else { '127.0.0.2' }
$apiPort = if ($BackendOnly) { $Port } else { $BackendPort }
$publicPorts = @($Port, $FrontendPort, $BackendPort)
if (-not $BackendOnly) {
    if (@($publicPorts | Select-Object -Unique).Count -ne 3) { throw 'Port, FrontendPort and BackendPort must be different.' }
    $uiScript = Join-Path $PSScriptRoot 'serve-kanban-ui.mjs'
    $dist = Join-Path $RuntimePath "vibe-kanban-$($runtime.commit)/frontend/dist"
    if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) {
        throw 'Run setup-kanban-ui.ps1 first to build the open-source frontend.'
    }
    $dist = (Resolve-Path -LiteralPath $dist).Path
}
$git = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path (Split-Path $git -Parent) -Parent
$bash = $null
foreach ($candidate in @($env:CLAUDE_CODE_GIT_BASH_PATH, (Join-Path $gitRoot 'bin/bash.exe'), (Join-Path $gitRoot 'usr/bin/bash.exe'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $identity = & $candidate -c 'uname -s' 2>$null
        if ($LASTEXITCODE -eq 0 -and $identity -match '^(MINGW|MSYS)') { $bash = (Resolve-Path -LiteralPath $candidate).Path; break }
    }
}
if (-not $bash) { throw 'Claude workers require Git Bash. Set CLAUDE_CODE_GIT_BASH_PATH to Git for Windows bash.exe.' }
$oldHostValue = $env:HOST
$oldPortValue = $env:PORT
$oldBackendPortValue = $env:BACKEND_PORT
$oldBashValue = $env:CLAUDE_CODE_GIT_BASH_PATH
$oldPathValue = $env:PATH
try {
    $env:HOST = $apiHost
    $env:PORT = [string]$apiPort
    $env:BACKEND_PORT = [string]$apiPort
    $env:CLAUDE_CODE_GIT_BASH_PATH = $bash
    $env:PATH = "$(Split-Path $bash -Parent);$(Join-Path $gitRoot 'usr/bin');$oldPathValue"
    $existingBackend = $null
    try { $existingBackend = Invoke-RestMethod -Uri "http://$($apiHost):$apiPort/api/info" -TimeoutSec 2 } catch {}
    if ($existingBackend -and (-not $existingBackend.success -or $existingBackend.data.config.last_app_version -ne $runtime.version)) {
        throw 'An incompatible backend is already running on the internal endpoint.'
    }
    if (-not $BackendOnly) {
        $existingUi = $null
        try { $existingUi = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__pr_cycle_ui" -TimeoutSec 2 } catch {}
        if ($existingUi) {
            if ($existingUi.component -ne 'react-virtuoso' -or $existingUi.backendPort -ne $apiPort -or $existingUi.backendHost -ne $apiHost -or -not $existingUi.tracking -or $existingUi.trackingDatabase -ne $TrackingDatabase) {
                throw "Port $Port still belongs to an older server. Finish active workers and stop the old launcher before migrating this entry point."
            }
        } else {
            # Listen before spawning the backend: its automatic browser URL must serve the replacement.
            $trackingArgs = @('--python', ('"' + $python + '"'))
            if ($TrackingDatabase) { $trackingArgs += @('--tracking-db', ('"' + $TrackingDatabase + '"')) }
            $uiProcess = Start-Process -FilePath $node -ArgumentList (@(
                ('"' + $uiScript + '"'), '--dist', ('"' + $dist + '"'), '--port', [string]$Port,
                '--alias-port', [string]$FrontendPort, '--alias-port', [string]$BackendPort,
                '--backend-port', [string]$apiPort, '--backend-host', $apiHost
            ) + $trackingArgs) -WindowStyle Hidden -PassThru
            $null = $uiProcess.Handle
        }
        foreach ($entryPort in $publicPorts) {
            $entry = $null
            for ($retry = 0; $retry -lt 20; $retry++) {
                if ($uiProcess -and $uiProcess.HasExited) { throw 'Frontend could not start; check for an old server occupying its ports.' }
                try { $entry = Invoke-RestMethod -Uri "http://127.0.0.1:$entryPort/__pr_cycle_ui" -TimeoutSec 1 } catch {}
                if ($entry) { break }
                Start-Sleep -Milliseconds 100
            }
            if (-not $entry -or $entry.component -ne 'react-virtuoso' -or $entry.backendHost -ne $apiHost -or $entry.backendPort -ne $apiPort) {
                throw "Entry port $entryPort does not serve the replacement frontend."
            }
        }
    }
    if (-not $existingBackend) {
        New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
        $backendLog = Join-Path $RuntimePath 'kanban-backend.log'
        $backendErrorLog = Join-Path $RuntimePath 'kanban-backend-error.log'
        $backendScript = Join-Path $PSScriptRoot 'run-kanban-backend.ps1'
        $backendProcess = Start-Process -FilePath powershell.exe -ArgumentList @(
            '-NoProfile', '-File', ('"' + $backendScript + '"')
        ) -WindowStyle Hidden -RedirectStandardOutput $backendLog -RedirectStandardError $backendErrorLog -PassThru
        $null = $backendProcess.Handle
        Write-Host "Starting pinned backend $($runtime.version). Log: $backendLog"
        $deadline = (Get-Date).AddSeconds(90)
        do {
            if ($backendProcess.HasExited) { throw "Backend exited before becoming ready. See $backendErrorLog" }
            try { $existingBackend = Invoke-RestMethod -Uri "http://$($apiHost):$apiPort/api/info" -TimeoutSec 1 } catch {}
            if ($existingBackend) { break }
            Start-Sleep -Milliseconds 300
        } while ((Get-Date) -lt $deadline)
        if (-not $existingBackend -or -not $existingBackend.success -or $existingBackend.data.config.last_app_version -ne $runtime.version) {
            throw "Pinned backend did not become ready. See $backendErrorLog"
        }
    }
    if (-not $BackendOnly) {
        $trackingArgs = @('--install')
        if ($TrackingDatabase) { $trackingArgs += @('--db', $TrackingDatabase) }
        & $python (Join-Path $PSScriptRoot 'kanban_tracking.py') @trackingArgs
        if ($LASTEXITCODE -ne 0) { throw 'Workflow tracking setup failed; database was not replaced.' }
    }
    & $python (Join-Path $PSScriptRoot 'use_local_clis.py') --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'Local CLI setup failed; see the diagnostic above before starting workers.' }
    Write-Host "PR cycle board / API / MCP: http://127.0.0.1:$Port"
    if (-not $BackendOnly) { Write-Host "Compatibility UI: http://127.0.0.1:$FrontendPort (same open-source frontend)" }
    $ownedProcess = if ($backendProcess) { $backendProcess } else { $uiProcess }
    if ($ownedProcess) {
        Write-Host 'Press Ctrl+C to stop services created by this launcher.'
        Wait-Process -Id $ownedProcess.Id
        $ownedProcess.WaitForExit()
        if ($ownedProcess.ExitCode -ne 0) { throw "Kanban service exited with code $($ownedProcess.ExitCode)" }
    } else { Write-Host 'Services already running. Local CLI bindings refreshed.' }
} finally {
    if ($uiProcess -and -not $uiProcess.HasExited) { Stop-Process -Id $uiProcess.Id }
    if ($backendProcess -and -not $backendProcess.HasExited) {
        & taskkill.exe /PID $backendProcess.Id /T /F | Out-Null
    }
    $env:HOST = $oldHostValue
    $env:PORT = $oldPortValue
    $env:BACKEND_PORT = $oldBackendPortValue
    $env:CLAUDE_CODE_GIT_BASH_PATH = $oldBashValue
    $env:PATH = $oldPathValue
}
