[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $TestFiles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-NodeExecutable {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }

  $fallback = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path -LiteralPath $fallback) {
    return $fallback
  }

  throw "Node.js was not found. Install Node.js or make sure Codex bundled Node exists at: $fallback"
}

$node = Resolve-NodeExecutable

foreach ($testFile in $TestFiles) {
  if (-not (Test-Path -LiteralPath $testFile)) {
    throw "Test file not found: $testFile"
  }

  & $node $testFile
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
