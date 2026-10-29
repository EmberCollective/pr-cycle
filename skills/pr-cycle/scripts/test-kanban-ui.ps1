param([ValidateRange(1024, 65535)][int]$Port = 13689)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../..')).Path
$runtime = Join-Path $repoRoot '.pr-cycle-runtime'
$board = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$frontend = Join-Path $runtime "vibe-kanban-$($board.commit)/frontend"
$vite = Join-Path $frontend 'node_modules/vite/bin/vite.js'
if (-not (Test-Path -LiteralPath $vite)) { throw 'Run setup-kanban-ui.ps1 before browser tests.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$fixture = Join-Path $frontend 'src/components/common/MessageListHarness.tsx'
$html = Join-Path $frontend 'message-list-test.html'
if ((Test-Path -LiteralPath $fixture) -or (Test-Path -LiteralPath $html)) {
    throw 'Test fixture files already exist; preserve or remove them before running the browser test.'
}
$process = $null
$oldUrl = $env:MESSAGE_LIST_TEST_URL
Push-Location -LiteralPath $repoRoot
try {
    & $npm install --prefix (Join-Path $runtime 'ui-tests') --no-audit --no-fund playwright@1.56.1
    if ($LASTEXITCODE -ne 0) { throw 'Playwright installation failed.' }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'tests/kanban-ui/MessageListHarness.tsx') -Destination $fixture
    [IO.File]::WriteAllText($html, '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/components/common/MessageListHarness.tsx"></script></body></html>')
    $process = Start-Process -FilePath $node -ArgumentList @(
        ('"' + $vite + '"'), '--host', '127.0.0.1', '--port', [string]$Port, '--strictPort'
    ) -WorkingDirectory $frontend -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput (Join-Path $runtime 'ui-test-vite.log') `
      -RedirectStandardError (Join-Path $runtime 'ui-test-vite-error.log')
    $env:MESSAGE_LIST_TEST_URL = "http://127.0.0.1:$Port/message-list-test.html"
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        if ($process.HasExited) { throw 'Browser test server failed to start; check its log.' }
        try { $null = Invoke-WebRequest -UseBasicParsing $env:MESSAGE_LIST_TEST_URL -TimeoutSec 1; $ready = $true; break } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Browser test server did not become ready.' }
    & $node (Join-Path $repoRoot 'tests/test_message_list_browser.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Message list browser tests failed.' }
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
    foreach ($file in @($fixture, $html)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    $env:MESSAGE_LIST_TEST_URL = $oldUrl
    Pop-Location
}
