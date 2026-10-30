param([string]$RuntimePath)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
if (-not $RuntimePath) { $RuntimePath = Join-Path $repoRoot '.pr-cycle-runtime' }
$null = New-Item -ItemType Directory -Path $RuntimePath -Force
$RuntimePath = (Resolve-Path -LiteralPath $RuntimePath).Path
$board = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$assets = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../assets/kanban-ui')).Path
$build = Get-Content -Raw -LiteralPath (Join-Path $assets 'build.lock.json') | ConvertFrom-Json
$archive = Join-Path $RuntimePath 'vibe-source.zip'
$source = Join-Path $RuntimePath "vibe-kanban-$($board.commit)"
$git = (Get-Command git.exe -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $archive)) {
    & curl.exe -fL --retry 2 --connect-timeout 20 -o "$archive.download" "https://codeload.github.com/BloopAI/vibe-kanban/zip/$($board.commit)"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to download pinned frontend source.' }
    if ((Get-FileHash -LiteralPath "$archive.download" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.source_sha256) {
        throw 'Downloaded source archive checksum mismatch.'
    }
    Move-Item -LiteralPath "$archive.download" -Destination $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $build.source_sha256) {
    throw 'Source archive checksum mismatch.'
}
if (-not (Test-Path -LiteralPath $source)) { Expand-Archive -LiteralPath $archive -DestinationPath $RuntimePath }
$patch = Join-Path $assets 'frontend.patch'
$savedPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $git -C $source apply --reverse --check $patch 2>$null
$alreadyPatched = $LASTEXITCODE -eq 0
$ErrorActionPreference = $savedPreference
if (-not $alreadyPatched) {
    & $git -C $source apply --check $patch
    if ($LASTEXITCODE -ne 0) { throw 'Frontend source differs from the pinned patch; preserve changes before rebuilding.' }
    & $git -C $source apply $patch
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply open-source message list patch.' }
}
Copy-Item -LiteralPath (Join-Path $assets 'MessageList.tsx') -Destination (Join-Path $source 'frontend/src/components/common/MessageList.tsx')
Copy-Item -LiteralPath (Join-Path $assets 'WorkflowBoard.tsx') -Destination (Join-Path $source 'frontend/src/components/tasks/TaskKanbanBoard.tsx')
Copy-Item -LiteralPath (Join-Path $assets 'workflow-board.css') -Destination (Join-Path $source 'frontend/src/components/tasks/workflow-board.css')
Copy-Item -LiteralPath (Join-Path $assets 'conversationEntries.ts') -Destination (Join-Path $source 'frontend/src/utils/conversationEntries.ts')
foreach ($patchName in @('conversation-events.patch', 'workflow-page.patch')) {
    $uiPatch = Join-Path $assets $patchName
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $git -C $source apply --reverse --check $uiPatch 2>$null
    $uiPatched = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $savedPreference
    if (-not $uiPatched) {
        & $git -C $source apply --check $uiPatch
        if ($LASTEXITCODE -ne 0) { throw "Frontend source differs from $patchName; preserve changes before rebuilding." }
        & $git -C $source apply $uiPatch
        if ($LASTEXITCODE -ne 0) { throw "Could not apply $patchName." }
    }
}
Push-Location -LiteralPath $source
try {
    & $npx -y "pnpm@$($build.pnpm_version)" --filter ./frontend install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    & $npx -y "pnpm@$($build.pnpm_version)" --filter ./frontend run build
    if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    $dist = Join-Path $source 'frontend/dist'
    $commercial = Get-ChildItem -LiteralPath (Join-Path $dist 'assets') -Filter '*.js' -File |
        Select-String -Pattern 'virtuoso.dev/message-list|VirtuosoMessageListLicense|annual license key'
    if ($commercial) { throw 'Commercial message list remains in the frontend build.' }
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $dist 'VIBE-KANBAN-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $source 'frontend/node_modules/react-virtuoso/LICENSE') -Destination (Join-Path $dist 'REACT-VIRTUOSO-LICENSE.txt')
    $notice = "Built from Vibe Kanban $($board.version), commit $($board.commit) (Apache-2.0).`nMessage list replaced by pr-cycle using react-virtuoso (MIT).`n"
    [IO.File]::WriteAllText((Join-Path $dist 'PR-CYCLE-NOTICE.txt'), $notice)
    Write-Host "Open-source frontend built: $dist"
} finally { Pop-Location }
