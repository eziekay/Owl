$ErrorActionPreference = 'Stop'
$owlAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $owlAdmin) {
  $owlProcess = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  exit $owlProcess.ExitCode
}
$owlRule = Get-NetFirewallRule -DisplayName 'Owl LAN' -ErrorAction SilentlyContinue
if ($owlRule) { Remove-NetFirewallRule -DisplayName 'Owl LAN' }
New-NetFirewallRule -DisplayName 'Owl LAN' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 -Profile Any -RemoteAddress LocalSubnet | Out-Null
Write-Output 'Owl LAN firewall rule is enabled for devices on the local subnet.'
