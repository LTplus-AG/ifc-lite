/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';

export interface PhysicalSessionReceipt {
  currentSession: number;
  consoleSession: number;
  protocol: number;
  connectState: number;
  remoteMetric: number;
  monitors: number;
}

/** WTS protocol + physical console identity; SM_REMOTESESSION alone misses RemoteFX. */
export function isPhysicalConsole(receipt: PhysicalSessionReceipt): boolean {
  return receipt.consoleSession !== 0xffffffff
    && receipt.currentSession === receipt.consoleSession
    && receipt.protocol === 0 && receipt.connectState === 0
    && receipt.remoteMetric === 0 && receipt.monitors > 0;
}

// WTSClientProtocolType=16 (0 console, 2 RDP), WTSConnectState=8 (0 active).
// References: Microsoft WTSQuerySessionInformation / WTSGetActiveConsoleSessionId.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IfcFrameSession {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("wtsapi32.dll", SetLastError=true)]
  public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int field, out IntPtr data, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr data);
  public static int Query(int session, int field, bool shortValue) {
    IntPtr data; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, field, out data, out bytes))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try { return shortValue ? Marshal.ReadInt16(data) : Marshal.ReadInt32(data); }
    finally { WTSFreeMemory(data); }
  }
}
'@
$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
@{
  currentSession = $session
  consoleSession = [IfcFrameSession]::WTSGetActiveConsoleSessionId()
  protocol = [IfcFrameSession]::Query($session, 16, $true)
  connectState = [IfcFrameSession]::Query($session, 8, $false)
  remoteMetric = [IfcFrameSession]::GetSystemMetrics(0x1000)
  monitors = [IfcFrameSession]::GetSystemMetrics(80)
} | ConvertTo-Json -Compress
`;

/** Read-only Windows admission. No usernames, credentials or process command lines retained. */
export function readPhysicalSession(): PhysicalSessionReceipt {
  const parsed = readPowerShellJson(SCRIPT);
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid physical session receipt');
  for (const field of ['currentSession', 'consoleSession', 'protocol', 'connectState', 'remoteMetric', 'monitors']) {
    const value: unknown = Reflect.get(parsed, field);
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`invalid session field ${field}`);
  }
  return parsed as PhysicalSessionReceipt;
}

function readPowerShellJson(script: string): unknown {
  const run = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 15_000 });
  if (run.error || run.status !== 0) throw new Error(`Windows observation failed: ${run.error?.message ?? run.stderr}`);
  return JSON.parse(run.stdout.replace(/^\uFEFF/, '').trim()) as unknown;
}

export interface WindowsHostObservation {
  capturedAt: string;
  totalProcessorPercent: number;
  freePhysicalKiB: number;
  totalVisiblePhysicalKiB: number;
  gpu: { status: 'available'; engines: { name: string; utilizationPercent: number }[] }
    | { status: 'unavailable'; error: string };
}

/**
 * Raw whole-host observations, not a GPU quiet verdict. CPU/free-memory fields
 * retain the v12 native Windows admission contract: three one-second samples
 * of Win32_PerfFormattedData_PerfOS_Processor (_Total) and Win32_OperatingSystem.
 * GPU engine counters include other processes; their percentages must not be
 * summed into a fictional adapter utilization or treated as idle if unavailable.
 */
export function readWindowsHostObservations(): WindowsHostObservation[] {
  const parsed = readPowerShellJson(`
$ErrorActionPreference = 'Stop'
$samples = @()
for ($sampleIndex = 0; $sampleIndex -lt 3; $sampleIndex++) {
  $cpuRecords = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'")
  $memoryRecords = @(Get-CimInstance Win32_OperatingSystem)
  if ($cpuRecords.Count -ne 1 -or $memoryRecords.Count -ne 1) {
    throw 'Expected exactly one total CPU and operating-system memory record'
  }
  $cpu = $cpuRecords[0]
  $memory = $memoryRecords[0]
  try {
    $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {
      @{ name = $_.Name; utilizationPercent = $_.UtilizationPercentage }
    })
    $gpu = if ($engines.Count -gt 0) { @{ status = 'available'; engines = $engines } }
      else { @{ status = 'unavailable'; error = 'No GPU engine counters returned' } }
  } catch {
    $gpu = @{ status = 'unavailable'; error = $_.Exception.Message }
  }
  $samples += @{
    capturedAt = [DateTime]::UtcNow.ToString('o')
    totalProcessorPercent = $cpu.PercentProcessorTime
    freePhysicalKiB = $memory.FreePhysicalMemory
    totalVisiblePhysicalKiB = $memory.TotalVisibleMemorySize
    gpu = $gpu
  }
  if ($sampleIndex -lt 2) { Start-Sleep -Milliseconds 1000 }
}
ConvertTo-Json -InputObject $samples -Depth 6 -Compress
`);
  return decodeWindowsHostObservations(parsed);
}

/** The real PowerShell wrapper's fail-closed decoder, also usable for retained raw receipts. */
export function decodeWindowsHostObservations(parsed: unknown): WindowsHostObservation[] {
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('expected three Windows host observations');
  for (const sample of parsed) {
    if (!sample || typeof sample !== 'object' || typeof sample.capturedAt !== 'string'
      || !Number.isFinite(Date.parse(sample.capturedAt))) throw new Error('invalid Windows observation timestamp');
    for (const field of ['totalProcessorPercent', 'freePhysicalKiB', 'totalVisiblePhysicalKiB']) {
      const value: unknown = Reflect.get(sample, field);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid host field ${field}`);
    }
    if (sample.totalProcessorPercent > 100) throw new Error('invalid host CPU utilization');
    if (sample.totalVisiblePhysicalKiB <= 0 || sample.freePhysicalKiB > sample.totalVisiblePhysicalKiB) {
      throw new Error('invalid host physical memory observation');
    }
    const gpu: unknown = sample.gpu;
    if (!gpu || typeof gpu !== 'object') throw new Error('missing GPU observation status');
    if (Reflect.get(gpu, 'status') === 'unavailable') {
      if (typeof Reflect.get(gpu, 'error') !== 'string') throw new Error('missing GPU counter error');
    } else if (Reflect.get(gpu, 'status') === 'available') {
      const engines: unknown = Reflect.get(gpu, 'engines');
      if (!Array.isArray(engines) || engines.length === 0 || engines.some((engine: unknown) => {
        if (!engine || typeof engine !== 'object') return true;
        const value: unknown = Reflect.get(engine, 'utilizationPercent');
        return typeof Reflect.get(engine, 'name') !== 'string' || typeof value !== 'number'
          || !Number.isFinite(value) || value < 0 || value > 100;
      })) throw new Error('invalid GPU engine observations');
    } else throw new Error('unknown GPU counter availability');
  }
  return parsed as WindowsHostObservation[];
}
