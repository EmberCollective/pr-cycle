param([ValidateRange(1024, 65535)][int]$Port = 13680)
$ErrorActionPreference = 'Stop'
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path (Split-Path $git -Parent) -Parent
$bash = $null
foreach ($candidate in @($env:CLAUDE_CODE_GIT_BASH_PATH, (Join-Path $gitRoot 'bin/bash.exe'), (Join-Path $gitRoot 'usr/bin/bash.exe'))) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $identity = & $candidate -c 'uname -s' 2>$null
        if ($LASTEXITCODE -eq 0 -and $identity -match '^(MINGW|MSYS)') { $bash = (Resolve-Path -LiteralPath $candidate).Path; break }
    }
}
if (-not $bash) { throw 'Claude workers require Git Bash. Set CLAUDE_CODE_GIT_BASH_PATH to Git for Windows bash.exe, not the WSL launcher.' }
$oldHostValue = $env:HOST
$oldPortValue = $env:PORT
$oldBackendPortValue = $env:BACKEND_PORT
$oldBashValue = $env:CLAUDE_CODE_GIT_BASH_PATH
$oldPathValue = $env:PATH
try {
    $env:HOST = '127.0.0.1'
    $env:PORT = [string]$Port
    $env:BACKEND_PORT = [string]$Port
    $env:CLAUDE_CODE_GIT_BASH_PATH = $bash
    $env:PATH = "$(Split-Path $bash -Parent);$(Join-Path $gitRoot 'usr/bin');$oldPathValue"
    Write-Host "PR cycle board: http://127.0.0.1:$Port"
    Write-Host "Pinned version $($runtime.version). Press Ctrl+C in this terminal to stop."
    Write-Host "Claude worker Git Bash: $bash"
    & $npx -y "vibe-kanban@$($runtime.version)"
    if ($LASTEXITCODE -ne 0) { throw "Vibe Kanban exited with code $LASTEXITCODE" }
} finally {
    $env:HOST = $oldHostValue
    $env:PORT = $oldPortValue
    $env:BACKEND_PORT = $oldBackendPortValue
    $env:CLAUDE_CODE_GIT_BASH_PATH = $oldBashValue
    $env:PATH = $oldPathValue
}
