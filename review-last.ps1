$ErrorActionPreference = "Stop"

git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not a git repository."
    exit 1
}

$head = git rev-parse HEAD
$upstream = git rev-parse '@{u}' 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Current branch has no upstream."
    exit 1
}

if ($head -eq $upstream) {
    $status = git status --porcelain
    if ($status) {
        Write-Host "Working tree is not clean. Aborting."
        exit 1
    }

    Write-Host "Review ON: showing changes from the last commit."
    git reset --soft HEAD^
} else {
    Write-Host "Review OFF: restoring upstream state."
    git reset --hard '@{u}'
}
