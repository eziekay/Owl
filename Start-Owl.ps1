param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$owlRoot = $PSScriptRoot
$owlUrl = 'http://127.0.0.1:4173'
$owlRunning = $false
try {
  $owlHealth = Invoke-RestMethod -Uri "$owlUrl/api/health" -TimeoutSec 3
  $owlRunning = $owlHealth.service -eq 'owl-newsletter'
} catch { }
if (-not $owlRunning) {
  $owlNode = Get-Command node -ErrorAction SilentlyContinue
  $owlNodePath = if ($owlNode) { $owlNode.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
  if (-not (Test-Path -LiteralPath $owlNodePath)) { throw 'Node.js could not be found. Open Owl in Codex to restore its local runtime.' }
  $owlLogs = Join-Path $owlRoot 'data'
  New-Item -Path $owlLogs -ItemType Directory -Force | Out-Null
  Start-Process -FilePath $owlNodePath -ArgumentList 'server.mjs' -WorkingDirectory $owlRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $owlLogs 'server.log') -RedirectStandardError (Join-Path $owlLogs 'server-error.log') | Out-Null
  for ($owlAttempt = 0; $owlAttempt -lt 20; $owlAttempt++) {
    Start-Sleep -Milliseconds 250
    try {
      $owlHealth = Invoke-RestMethod -Uri "$owlUrl/api/health" -TimeoutSec 2
      if ($owlHealth.service -eq 'owl-newsletter') { $owlRunning = $true; break }
    } catch { }
  }
  if (-not $owlRunning) { throw 'Owl could not start. Check data/server-error.log; another app may be using port 4173.' }
}
if (-not $NoBrowser) { Start-Process $owlUrl }
Write-Output "Owl is available at $owlUrl"
$owlWifi = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
  Where-Object { $_.NetworkInterfaceType -eq 'Wireless80211' -and $_.OperationalStatus -eq 'Up' } |
  Select-Object -First 1
if ($owlWifi) {
  $owlAddress = $owlWifi.GetIPProperties().UnicastAddresses |
    Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
    Select-Object -First 1
  if ($owlAddress) { Write-Output "On your Wi-Fi, open http://$($owlAddress.Address.IPAddressToString):4173 on another device" }
}
