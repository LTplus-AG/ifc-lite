# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Run elevated. Installs key-only SSH restricted to one operator IP.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: .*)?$')][string]$PublicKey,
  [Parameter(Mandatory=$true)][string]$OperatorAddress
)
$ErrorActionPreference='Stop'
$parsedAddress=$null
if(-not [Net.IPAddress]::TryParse($OperatorAddress,[ref]$parsedAddress)){throw 'OperatorAddress must be one literal IP address'}
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run from an elevated administrator PowerShell'}
Write-Host 'IFClite: preparing key-only operator access'
if(-not(Get-Service sshd -ErrorAction SilentlyContinue)){Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null}
$sshDir=Join-Path $env:ProgramData 'ssh'
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
$keyFile=Join-Path $sshDir 'administrators_authorized_keys'
if(-not(Test-Path $keyFile)){New-Item -ItemType File -Path $keyFile | Out-Null}
if(-not((Get-Content $keyFile) -contains $publicKey)){Add-Content -Path $keyFile -Value $publicKey -Encoding ascii}
$acl=New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true,$false)
$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))
foreach($sid in @('S-1-5-32-544','S-1-5-18')){$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow')))}
Set-Acl -LiteralPath $keyFile -AclObject $acl
$config=Join-Path $sshDir 'sshd_config'
if(-not(Test-Path $config)){Copy-Item "$env:WINDIR\System32\OpenSSH\sshd_config_default" $config}
if(-not(Test-Path "$config.ifclite-before")){Copy-Item $config "$config.ifclite-before"}
Set-Content -Path $config -Value ("PasswordAuthentication no`nPubkeyAuthentication yes`n"+[IO.File]::ReadAllText($config)) -Encoding ascii
& "$env:WINDIR\System32\OpenSSH\sshd.exe" -t
if($LASTEXITCODE -ne 0){throw 'SSH configuration validation failed'}
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule
if(Get-NetFirewallRule -Name 'IFClite-Operator-SSH' -ErrorAction SilentlyContinue){Remove-NetFirewallRule -Name 'IFClite-Operator-SSH'}
New-NetFirewallRule -Name 'IFClite-Operator-SSH' -DisplayName 'IFClite operator SSH' -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress $parsedAddress.ToString() -Action Allow | Out-Null
Set-Service sshd -StartupType Automatic
Start-Service sshd
Restart-Service sshd
Write-Host 'IFClite: operator SSH ready; host fingerprint follows'
& "$env:WINDIR\System32\OpenSSH\ssh-keygen.exe" -lf "$sshDir\ssh_host_ed25519_key.pub"
