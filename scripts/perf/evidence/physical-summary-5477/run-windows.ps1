param(
  [Parameter(Mandatory = $true)][string]$Run,
  [Parameter(Mandatory = $true)][ValidateSet('base','candidate')][string]$Variant,
  [Parameter(Mandatory = $true)][ValidateSet('Holter','AC20','ISSUE129')][string]$Fixture,
  [Parameter(Mandatory = $true)][string]$Checkout,
  [Parameter(Mandatory = $true)][string]$BuildRoot,
  [Parameter(Mandatory = $true)][string]$FixtureRoot,
  [Parameter(Mandatory = $true)][string]$ChromePath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [string]$NodeExe = 'node.exe', [int]$Port = 5276
)
$ErrorActionPreference = 'Stop'
$base = $OutputDir
$checkout = $Checkout
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$out = Join-Path $base ('physical-summary-5477-prod-' + $Run)
$started = Get-Date
$node = $NodeExe
$args = @(
  (Join-Path $checkout 'node_modules\tsx\dist\cli.mjs'),
  (Join-Path $PSScriptRoot 'witness.mts'),
  $out
)
$fixtureName = switch ($Fixture) {
  'Holter' { 'ISSUE_053_20181220Holter_Tower_10.ifc' }
  'AC20' { 'AC20-FZK-Haus.ifc' }
  'ISSUE129' { 'ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc' }
}
$fixturePath = Join-Path $FixtureRoot $fixtureName
$port = $Port
$env:WITNESS_ORIGIN = 'http://127.0.0.1:' + $port
if (-not (Test-Path $fixturePath)) { throw "Fixture missing: $fixturePath" }
$env:WITNESS_FIXTURE = $fixturePath
$chromePath = $ChromePath
$env:WITNESS_CHECKOUT = $Checkout
$env:WITNESS_CHROME = $ChromePath
$env:WITNESS_VARIANT = $Variant
$affinityMask = [IntPtr]0xFFF000
$affinityByPid = [ordered]@{}
$preLoadAffinityByPid = [ordered]@{}
$elevated = [System.Collections.Generic.HashSet[int]]::new()
$foreignChrome = @(Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $chromePath })
if ($foreignChrome.Count -gt 0) { throw "Another Playwright Chromium is active: $($foreignChrome.Id -join ',')" }
$gate = Join-Path $base ('physical-summary-5477-affinity-' + $Run + '.gate')
$loadGate = Join-Path $base ('physical-summary-5477-load-' + $Run + '.gate')
$loadReady = Join-Path $base ('physical-summary-5477-ready-' + $Run + '.gate')
if (Test-Path $gate) { Remove-Item $gate -Force }
if (Test-Path $loadGate) { Remove-Item $loadGate -Force }
if (Test-Path $loadReady) { Remove-Item $loadReady -Force }
$env:WITNESS_START_GATE = $gate
$env:WITNESS_LOAD_GATE = $loadGate
$env:WITNESS_LOAD_READY = $loadReady
$witnessSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'witness.mts') -Algorithm SHA256).Hash.ToLower()
$runnerSha256 = (Get-FileHash $PSCommandPath -Algorithm SHA256).Hash.ToLower()
$viteId = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
$vite = Get-Process -Id $viteId -ErrorAction Stop
$viteOriginalPriority = $vite.PriorityClass
if ($vite.ProcessorAffinity.ToInt64() -ne $affinityMask.ToInt64()) { throw "Task server affinity is not 0xFFF000: $($vite.ProcessorAffinity)" }
$serverAffinityDuringRun = ('0x{0:X}' -f $vite.ProcessorAffinity.ToInt64())
$vite.PriorityClass = 'High'
$p = Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $checkout -PassThru `
  -RedirectStandardOutput ($out + '.stdout.log') -RedirectStandardError ($out + '.stderr.log')
$p.ProcessorAffinity = $affinityMask
$p.PriorityClass = 'High'
$affinityByPid[[string]$p.Id] = ('0x{0:X}' -f $p.ProcessorAffinity.ToInt64())
$null = $elevated.Add($p.Id)
Set-Content -Path $gate -Value 'affinity-ready'
while (-not $p.HasExited) {
  foreach ($child in (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
    try {
      if ($child.Path -eq $chromePath) {
        $currentAffinity = $child.ProcessorAffinity
        if ($null -eq $currentAffinity) { throw 'Chrome process exited during affinity read' }
        if ($currentAffinity.ToInt64() -ne $affinityMask.ToInt64()) { $child.ProcessorAffinity = $affinityMask }
        if ($child.PriorityClass -ne 'High') { $child.PriorityClass = 'High' }
        $currentAffinity = $child.ProcessorAffinity
        if ($null -eq $currentAffinity) { throw 'Chrome process exited during affinity read' }
        $affinityByPid[[string]$child.Id] = ('0x{0:X}' -f $currentAffinity.ToInt64())
        $null = $elevated.Add($child.Id)
      }
    } catch {
      if (Get-Process -Id $child.Id -ErrorAction SilentlyContinue) { throw }
      # Chromium children may exit between enumeration and priority update.
    }
  }
  if ((Test-Path $loadReady) -and -not (Test-Path $loadGate)) {
    $readyChildren = @(Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $chromePath })
    if ($readyChildren.Count -gt 0) {
      foreach ($child in $readyChildren) {
        try {
          $child.ProcessorAffinity = $affinityMask
          $child.PriorityClass = 'High'
          $currentAffinity = $child.ProcessorAffinity
          if ($null -eq $currentAffinity) { throw 'Chrome process exited during preload affinity read' }
          $preLoadAffinityByPid[[string]$child.Id] = ('0x{0:X}' -f $currentAffinity.ToInt64())
        } catch {
          if (Get-Process -Id $child.Id -ErrorAction SilentlyContinue) { throw }
        }
      }
      $preLoadAffinityByPid[[string]$p.Id] = ('0x{0:X}' -f $p.ProcessorAffinity.ToInt64())
      $preload = [ordered]@{
        time = (Get-Date).ToString('o'); run = $Run; variant = $env:WITNESS_VARIANT
        affinityMask = '0xFFF000'; launcherPid = $p.Id; serverPid = $viteId
        serverAffinity = $serverAffinityDuringRun; processAffinityByPid = $preLoadAffinityByPid
        witnessSha256 = $witnessSha256; runnerSha256 = $runnerSha256
      }
      $preload | ConvertTo-Json | Set-Content -Path ($out + '.preload.json')
      Set-Content -Path $loadGate -Value 'all-current-browser-processes-pinned'
    }
  }
  Start-Sleep -Milliseconds 250
  $p.Refresh()
}
$p.WaitForExit()
$p.Refresh()
$code = $p.ExitCode
if (Test-Path $gate) { Remove-Item $gate -Force }
if (Test-Path $loadGate) { Remove-Item $loadGate -Force }
if (Test-Path $loadReady) { Remove-Item $loadReady -Force }
$vite.PriorityClass = $viteOriginalPriority
$outcome = if (Test-Path ($out + '.json')) {
  Get-Content -Raw ($out + '.json') | ConvertFrom-Json
} else { $null }
$witnessExit = if ($outcome -and $outcome.ok) { 0 } else { 1 }
$sourceFiles = @(
  'apps/viewer/src/lib/physical-objects.ts',
  'apps/viewer/src/components/viewer/properties/ModelMetadataPanel.tsx',
  'apps/viewer/src/components/viewer/properties/modelMetadataStats.ts'
)
$sourceHashes = [ordered]@{}
foreach ($relative in $sourceFiles) {
  $sourceHashes[$relative] = (Get-FileHash (Join-Path $checkout $relative) -Algorithm SHA256).Hash.ToLower()
}
$variant = $Variant
$manifestPath = Join-Path (Join-Path $BuildRoot $variant) 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "Build manifest missing: $manifestPath" }
$servedManifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$method = [ordered]@{
  witnessExitCode = $witnessExit
  launcherExitCode = $code
  started = $started.ToString('o')
  finished = (Get-Date).ToString('o')
  processId = $p.Id
  processPriority = 'High'
  affinityMask = '0xFFF000'
  launcherAffinityDuringRun = $affinityByPid[[string]$p.Id]
  serverAffinityDuringRun = $serverAffinityDuringRun
  affinityByPid = $affinityByPid
  preLoadAffinityByPid = $preLoadAffinityByPid
  witnessSha256 = $witnessSha256
  runnerSha256 = $runnerSha256
  viteProcessId = $viteId
  vitePriorityDuringRun = 'High'
  chromiumExecutable = $chromePath
  elevatedProcessIds = @($elevated | Sort-Object)
  checkoutHead = (git -C $checkout rev-parse HEAD).Trim()
  wasmSha256 = (Get-FileHash (Join-Path $checkout 'packages\wasm\pkg\ifc-lite_bg.wasm') -Algorithm SHA256).Hash.ToLower()
  origin = $env:WITNESS_ORIGIN
  serverScriptSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'static-server.mjs') -Algorithm SHA256).Hash.ToLower()
  fixture = $fixturePath
  fixtureSha256 = (Get-FileHash $fixturePath -Algorithm SHA256).Hash.ToLower()
  checkoutSourceHashes = $sourceHashes
  servedVariant = $variant
  servedSourceHashes = $servedManifest.sourceHashes
  servedManifestSha256 = (Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLower()
  servedEntryJsSha256 = $servedManifest.entryJsSha256
  servedWasmSha256 = $servedManifest.wasmSha256
}
$method | ConvertTo-Json | Set-Content -Path ($out + '.method.json')
Get-Content ($out + '.stdout.log')
if ($witnessExit -ne 0) { exit 1 }
