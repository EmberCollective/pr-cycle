param(
    [string]$ProjectPath = (Get-Location).Path,
    [string]$RuntimePath,
    [ValidateRange(1024, 65535)][int]$Port = 13680,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw 'ProjectPath must be a directory.' }
if (-not $RuntimePath) { $RuntimePath = Join-Path $repoRoot '.pr-cycle-runtime' }
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath).Path
$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/claude-runtime.lock.json') | ConvertFrom-Json
$board = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$source = Join-Path $RuntimePath 'claude-plugins-official'
$plugin = Join-Path $source $lock.ralph_loop.plugin_path
$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$claudeLauncher = Join-Path $PSScriptRoot 'local-cli.mjs'
$null = Get-Command npx.cmd -ErrorAction Stop
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) { throw 'Run setup-claude-runtime.ps1 first.' }
$head = & $git -C $source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $lock.ralph_loop.commit) { throw 'Ralph source revision does not match the lock file.' }
$dirty = & $git -C $source status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Runtime source is modified; refusing to load its hooks.' }
$jq = Join-Path $RuntimePath 'bin/jq.exe'
if ((Get-FileHash -LiteralPath $jq -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.jq.sha256) { throw 'jq checksum does not match the lock file.' }
$state = Join-Path $ProjectPath '.claude/ralph-loop.local.md'
if (Test-Path -LiteralPath $state) {
    throw "An existing Ralph state must be reconciled before starting another loop: $state. Resume the original Claude session or explicitly cancel it; do not overwrite it."
}
# Prefer the Git for Windows installation, never the Windows WSL bash launcher.
$gitRoot = Split-Path (Split-Path $git -Parent) -Parent
$candidates = @($env:CLAUDE_CODE_GIT_BASH_PATH, (Join-Path $gitRoot 'bin/bash.exe'), (Join-Path $gitRoot 'usr/bin/bash.exe'))
$bash = $null
foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $identity = & $candidate -c 'uname -s' 2>$null
        if ($LASTEXITCODE -eq 0 -and $identity -match '^(MINGW|MSYS)') { $bash = (Resolve-Path -LiteralPath $candidate).Path; break }
    }
}
if (-not $bash) { throw 'Git Bash is required. Set CLAUDE_CODE_GIT_BASH_PATH to Git for Windows bash.exe, not the WSL launcher.' }
$oldPath = $env:PATH
$oldBash = $env:CLAUDE_CODE_GIT_BASH_PATH
$mcpFile = $null
$lease = $null
$pushed = $false
try {
    $env:CLAUDE_CODE_GIT_BASH_PATH = $bash
    $env:PATH = "$(Join-Path $RuntimePath 'bin');$(Split-Path $bash -Parent);$(Join-Path $gitRoot 'usr/bin');$oldPath"
    & $bash -c 'set -e; command -v bash jq perl sed grep awk >/dev/null; jq --version; perl -e "exit 0"'
    if ($LASTEXITCODE -ne 0) { throw 'Required Ralph hook dependencies are unavailable in Git Bash.' }
    & $node $claudeLauncher claude --version
    if ($LASTEXITCODE -ne 0) { throw 'Claude Code cannot execute.' }
    & $node $claudeLauncher claude plugin validate $repoRoot
    if ($LASTEXITCODE -ne 0) { throw 'The pr-cycle plugin manifest is invalid.' }
    & $node $claudeLauncher claude plugin validate $plugin
    if ($LASTEXITCODE -ne 0) { throw 'The Ralph plugin manifest is invalid.' }
    try { $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/projects" -TimeoutSec 5 }
    catch { throw "Vibe Kanban is not reachable on port $Port. Start start-kanban.ps1 -Port $Port first. $($_.Exception.Message)" }
    if (-not $response.success) { throw 'The Vibe Kanban projects API did not return success.' }
    $info = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/info" -TimeoutSec 5
    if (-not $info.success -or $info.data.config.last_app_version -ne $board.version) {
        throw "Vibe Kanban reported version does not match $($board.version). Use the pinned start-kanban.ps1."
    }
    $profiles = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/profiles" -TimeoutSec 5
    if (-not $profiles.success) { throw 'Cannot inspect Vibe Kanban worker permission profiles.' }
    $approvalProfile = ($profiles.data.content | ConvertFrom-Json).executors.CLAUDE_CODE.APPROVALS.CLAUDE_CODE
    if (-not $approvalProfile -or $approvalProfile.approvals -ne $true -or $approvalProfile.dangerously_skip_permissions -eq $true) {
        throw 'CLAUDE_CODE / APPROVALS must enable approvals without dangerously_skip_permissions. Do not use the unsafe DEFAULT profile.'
    }
    Write-Host "Checks passed. Project: $ProjectPath"
    Write-Host "Git Bash: $bash"
    Write-Host 'Workers must use executor CLAUDE_CODE with variant APPROVALS, not DEFAULT.'
    Write-Host 'In Claude, provide the confirmed request, then run:'
    Write-Host '/ralph-loop:ralph-loop "Read the pr-cycle:pr-cycle skill and its references/claude-code.md. Execute the confirmed request in this conversation using the fixed workflow. Emit <promise>PR_CYCLE_HANDOFF</promise> only after safe handoff evidence is recorded and no workers remain active." --max-iterations 20 --completion-promise PR_CYCLE_HANDOFF'
    if ($CheckOnly) { return }
    $claudeDir = Join-Path $ProjectPath '.claude'
    New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null
    try { $lease = [IO.File]::Open((Join-Path $claudeDir 'pr-cycle-coordinator.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another PR-cycle launcher holds this project coordinator lock.' }
    if (Test-Path -LiteralPath $state) { throw 'Ralph state appeared during preflight; refusing to overwrite it.' }
    $mcpFile = Join-Path $RuntimePath ("mcp-{0}.json" -f [Guid]::NewGuid().ToString('N'))
    $config = @{mcpServers = @{vibe_kanban = @{command = 'cmd'; args = @('/c', 'npx', '-y', "vibe-kanban@$($board.version)", '--mcp'); env = @{VIBE_BACKEND_URL = "http://127.0.0.1:$Port"}}}}
    [IO.File]::WriteAllText($mcpFile, ($config | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Push-Location -LiteralPath $ProjectPath
    $pushed = $true
    & $node $claudeLauncher claude --plugin-dir $repoRoot --plugin-dir $plugin --mcp-config $mcpFile
    if ($LASTEXITCODE -ne 0) { throw "Claude Code exited with code $LASTEXITCODE" }
} finally {
    if ($pushed) { Pop-Location }
    if ($lease) { $lease.Dispose() }
    if ($mcpFile -and (Test-Path -LiteralPath $mcpFile)) { Remove-Item -LiteralPath $mcpFile }
    $env:PATH = $oldPath
    $env:CLAUDE_CODE_GIT_BASH_PATH = $oldBash
}
