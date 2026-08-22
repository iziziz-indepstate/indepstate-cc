[CmdletBinding()]
param()

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
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packageJson = Join-Path $repoRoot 'package.json'

if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "package.json not found at: $packageJson"
}

$runner = @"
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = process.argv[1];
const nodeDir = path.dirname(process.execPath);
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const script = pkg.scripts && pkg.scripts.test;

if (!script) {
  throw new Error('package.json does not define scripts.test');
}

const env = {
  ...process.env,
  PATH: nodeDir + path.delimiter + (process.env.PATH || '')
};

cp.execSync(script, {
  cwd: repoRoot,
  env,
  shell: true,
  stdio: 'inherit'
});
"@

& $node -e $runner $repoRoot
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
