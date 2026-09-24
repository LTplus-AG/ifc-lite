param(
  [Parameter(Mandatory = $true)][ValidateSet('base','candidate')][string]$Variant,
  [Parameter(Mandatory = $true)][string]$BuildRoot,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [string]$NodeExe = 'node.exe', [int]$Port = 5276
)
$ErrorActionPreference = 'Stop'
$base = $OutputDir
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$script = Join-Path $PSScriptRoot 'static-server.mjs'
$dist = Join-Path (Join-Path $BuildRoot $Variant) 'dist'
$manifest = Join-Path (Join-Path $BuildRoot $Variant) 'manifest.json'
$port = $Port
if (-not (Test-Path $dist) -or -not (Test-Path $manifest)) { throw "Missing $Variant build" }
$old = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($old) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.OwningProcess)"
  if (-not $owner -or $owner.Name -ne 'node.exe' -or $owner.CommandLine -notlike '*static-server.mjs*') {
    throw "Port $port belongs to another process: $($old.OwningProcess)"
  }
  Stop-Process -Id $old.OwningProcess -Force
}
$node = $NodeExe
$p = Start-Process -FilePath $node -ArgumentList @($script, $dist, "$port") -WorkingDirectory $base -PassThru `
  -RedirectStandardOutput (Join-Path $base ('physical-summary-5477-static-' + $Variant + '.stdout.log')) `
  -RedirectStandardError (Join-Path $base ('physical-summary-5477-static-' + $Variant + '.stderr.log'))
$p.ProcessorAffinity = [IntPtr]0xFFF000
if ($p.ProcessorAffinity.ToInt64() -ne 0xFFF000) { throw "Could not pin task server $($p.Id)" }
$p.PriorityClass = 'High'
$listener = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) { break }
}
if (-not $listener -or $listener.OwningProcess -ne $p.Id) { throw "Failed to bind task server for $Variant" }
$response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing
if ($response.StatusCode -ne 200 -or $response.Headers['Cross-Origin-Opener-Policy'] -ne 'same-origin' -or
    $response.Headers['Cross-Origin-Embedder-Policy'] -ne 'credentialless') { throw "Invalid task server response for $Variant" }
$event = [ordered]@{
  time = (Get-Date).ToString('o'); variant = $Variant; pid = $p.Id; port = $port
  affinityMask = ('0x{0:X}' -f $p.ProcessorAffinity.ToInt64())
  manifestSha256 = (Get-FileHash $manifest -Algorithm SHA256).Hash.ToLower()
}
($event | ConvertTo-Json -Compress) | Add-Content (Join-Path $base 'physical-summary-5477-server-switches.jsonl')
$event | ConvertTo-Json
