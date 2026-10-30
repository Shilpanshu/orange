# Authenticode-signs one file (Tauri calls this for the app exe and the installer, see release-v2.yml).
# Needs ORANGE_CERT_PATH (a .pfx) and ORANGE_CERT_PASSWORD.
param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
$kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$signtool = Get-ChildItem $kits -Recurse -Filter signtool.exe | Where-Object { $_.FullName -like '*\x64\*' } |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found' }
& $signtool.FullName sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com `
  /f $env:ORANGE_CERT_PATH /p $env:ORANGE_CERT_PASSWORD $File
if ($LASTEXITCODE -ne 0) { throw "signtool failed on $File" }
