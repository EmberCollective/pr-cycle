param([string]$RuntimePath)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
if (-not $RuntimePath) { $RuntimePath = Join-Path $repoRoot '.pr-cycle-runtime' }
$RuntimePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimePath)
$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/claude-runtime.lock.json') | ConvertFrom-Json
$git = (Get-Command git.exe -ErrorAction Stop).Source
$curl = (Get-Command curl.exe -ErrorAction Stop).Source
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'This bootstrap currently supports Windows x64 only.'
}
New-Item -ItemType Directory -Path $RuntimePath -Force | Out-Null
$source = Join-Path $RuntimePath 'claude-plugins-official'
if (Test-Path -LiteralPath $source) {
    if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
        throw "Existing source is not a Git checkout; leave it untouched: $source"
    }
    $head = & $git -C $source rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or $head -ne $lock.ralph_loop.commit) {
        throw "Existing source is incomplete or has a different revision; use a new RuntimePath: $source"
    }
    $dirty = & $git -C $source status --porcelain
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Existing runtime source is modified: $source" }
} else {
    & $git init $source
    if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize the runtime source checkout.' }
    & $git -C $source fetch --depth 1 $lock.ralph_loop.repository $lock.ralph_loop.commit
    if ($LASTEXITCODE -ne 0) { throw "Source fetch failed; preserve this directory for diagnosis and retry with a new RuntimePath: $source" }
    & $git -C $source checkout --detach $lock.ralph_loop.commit
    if ($LASTEXITCODE -ne 0) { throw 'Unable to check out the pinned Ralph revision.' }
}
$plugin = Join-Path $source $lock.ralph_loop.plugin_path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $plugin '.claude-plugin/plugin.json') | ConvertFrom-Json
if ($manifest.name -ne 'ralph-loop' -or $manifest.version -ne $lock.ralph_loop.version) {
    throw 'The upstream Ralph plugin manifest does not match the lock file.'
}
$bin = Join-Path $RuntimePath 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$jq = Join-Path $bin 'jq.exe'
if (-not (Test-Path -LiteralPath $jq)) {
    $download = Join-Path $bin ("jq-{0}.download" -f [Guid]::NewGuid().ToString('N'))
    & $curl --fail --location --retry 2 --connect-timeout 20 --max-time 180 --output $download $lock.jq.url
    if ($LASTEXITCODE -ne 0) { throw "jq download failed; partial file retained for diagnosis: $download" }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.jq.sha256) {
        throw "jq checksum mismatch; untrusted download was not installed: $download"
    }
    Move-Item -LiteralPath $download -Destination $jq
}
if ((Get-FileHash -LiteralPath $jq -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.jq.sha256) {
    throw "Existing jq checksum mismatch; file was not changed: $jq"
}
& $jq --version
if ($LASTEXITCODE -ne 0) { throw 'jq cannot execute.' }
Write-Host "Runtime ready: $RuntimePath"
Write-Host 'No global Claude settings or plugins were changed. Next run start-claude-cycle.ps1 -CheckOnly.'
