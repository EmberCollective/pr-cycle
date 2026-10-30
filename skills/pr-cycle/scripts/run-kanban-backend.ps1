# Internal child entry point. Environment and lifecycle belong to start-kanban.ps1.
$ErrorActionPreference = 'Stop'
$runtime = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../assets/runtime.lock.json') | ConvertFrom-Json
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
& $npx -y "vibe-kanban@$($runtime.version)"
exit $LASTEXITCODE
