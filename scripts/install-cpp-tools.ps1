$ErrorActionPreference = 'Stop'

$taskInstaller = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\setup.exe'
$taskVswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
$taskConfig = Join-Path $PSScriptRoot 'windows-build.vsconfig'
$taskInstallPath = & $taskVswhere -latest -version '[17.0,18.0)' -products '*' -property installationPath | Select-Object -First 1
$taskChannelId = & $taskVswhere -latest -version '[17.0,18.0)' -products '*' -property channelId | Select-Object -First 1
if (-not $taskInstallPath -or -not $taskChannelId) { throw 'Visual Studio 2022 was not found.' }
if ((Get-AuthenticodeSignature -LiteralPath $taskInstaller).Status -ne 'Valid') {
    throw 'Visual Studio Installer signature verification failed.'
}

# Add only the requested build components to the existing VS 2022 instance.
# Windows displays its own UAC prompt; this script never approves it or reboots.
$taskArguments = 'modify --installPath "' + $taskInstallPath.Trim() + '" --channelId ' + $taskChannelId.Trim() + ' --config "' + $taskConfig + '" --quiet --norestart'
$taskProcess = Start-Process -FilePath $taskInstaller -ArgumentList $taskArguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
if ($taskProcess.ExitCode -eq 3010) {
    Write-Output 'Build components installed. A manual Windows restart is required.'
} elseif ($taskProcess.ExitCode -ne 0) {
    throw "Visual Studio component installation failed: $($taskProcess.ExitCode)"
} else {
    Write-Output 'Build components installed.'
}
