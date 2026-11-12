$ErrorActionPreference = 'Stop'

# Dot-source this file to use the complete VS 2022 toolchain in this shell.
# This avoids selecting a newer, partially installed Visual Studio instance.
$taskVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$taskVsPath = & $taskVswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (-not $taskVsPath) { throw 'Visual Studio 2022 C++ build tools were not found.' }
$taskDevCmd = Join-Path $taskVsPath.Trim() 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path -LiteralPath $taskDevCmd)) { throw 'VsDevCmd.bat was not found.' }
$taskBuildEnvironment = & $env:ComSpec /d /s /c ('call "' + $taskDevCmd + '" -no_logo -arch=x64 -host_arch=x64 && set')
if ($LASTEXITCODE -ne 0) { throw 'Visual Studio environment initialization failed.' }
foreach ($taskEnvironmentLine in $taskBuildEnvironment) {
    if ($taskEnvironmentLine -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$taskCargoBin = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $taskCargoBin 'cargo.exe')) {
    $env:PATH = $taskCargoBin + ';' + $env:PATH
}
Write-Output ('Build environment: ' + $taskVsPath.Trim())
