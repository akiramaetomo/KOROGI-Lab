[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'dev:lan', 'test', 'test:browser', 'test:pages', 'typecheck', 'build', 'build:pages', 'check', 'install', 'env')]
    [string]$Task = 'dev',
    [string]$TestPath = ''
)

$ErrorActionPreference = 'Stop'
$taskNodeVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '.node-version') -Raw).Trim()
$taskFnmCommand = Get-Command fnm.exe -ErrorAction SilentlyContinue
$taskFnmPath = if ($taskFnmCommand) { $taskFnmCommand.Source } else {
    Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Schniz.fnm_Microsoft.Winget.Source_8wekyb3d8bbwe\fnm.exe'
}
if (-not (Test-Path -LiteralPath $taskFnmPath)) {
    throw 'fnm.exe is not visible in this shell. Use the host PowerShell with fnm installed; do not change the project or system PATH.'
}

Push-Location $PSScriptRoot
try {
    if ($Task -eq 'env') {
        & $taskFnmPath exec --using $taskNodeVersion node --version
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & $taskFnmPath exec --using $taskNodeVersion npm.cmd --version
        exit $LASTEXITCODE
    }
    if ($Task -eq 'install') {
        & $taskFnmPath exec --using $taskNodeVersion npm.cmd ci
        exit $LASTEXITCODE
    }
    $taskCommands = if ($Task -eq 'check') { @('test', 'test:browser', 'typecheck', 'build') } else { @($Task) }
    foreach ($taskCommand in $taskCommands) {
        if ($taskCommand -eq 'dev:lan') {
            & $taskFnmPath exec --using $taskNodeVersion npm.cmd run dev -- --host 0.0.0.0 --port 5173 --strictPort
        } elseif ($taskCommand -eq 'test:browser' -and $TestPath) {
            & $taskFnmPath exec --using $taskNodeVersion npm.cmd run test:browser -- $TestPath
        } else {
            & $taskFnmPath exec --using $taskNodeVersion npm.cmd run $taskCommand
        }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    Pop-Location
}
