/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { WindowsChrome } from './frame-gpu-chrome.js';
import { decodeNativeOutput, type NativeOutputProfile } from './frame-gpu-night-admission.js';
import { readPowerShellJson } from './frame-gpu-session.js';

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Read the output of the actual held-identity Chrome root inside its owned Job.
 * This is display configuration, never proof that a panel is powered or 120 Hz.
 */
export async function readOwnedChromeOutput(chrome: WindowsChrome): Promise<{
  output: NativeOutputProfile; executableWin: string;
}> {
  const members = await chrome.job.controller.snapshot();
  const winPath = (file: string) => execFileSync('wslpath', ['-w', fileURLToPath(new URL(file, import.meta.url))],
    { encoding: 'utf8', timeout: 5000 }).trim();
  const script = `
$ErrorActionPreference='Stop'
Add-Type -Path ${literal(winPath('./frame-gpu-process-identity.cs'))}
${readFileSync(new URL('./frame-gpu-owned-profile.ps1', import.meta.url), 'utf8')}
${readFileSync(new URL('./frame-gpu-window-profile.ps1', import.meta.url), 'utf8')}
$members=ConvertFrom-Json ${literal(JSON.stringify(members))}
$rows=@(Get-OwnedChromeProcesses -Profile ${literal(chrome.profileWin)} -BrowserRoot -RequireCompleteObservation)
if($rows.Count-ne 1){throw 'Actual owned browser root unavailable'}
$member=@($members|Where-Object {$_.pid-eq $rows[0].ProcessId})
if($member.Count-ne 1){throw 'Actual browser root outside its owned Job'}
if($rows[0].ProcessId-ne ${chrome.job.prepared.job.rootPid}-or $member[0].started-ne ${literal(chrome.job.prepared.job.rootCreated)}){throw 'Actual browser root differs from prepared native identity'}
$root=[Diagnostics.Process]::GetProcessById([int]$rows[0].ProcessId)
try {
  $null=$root.Handle
  if([IfcProcessIdentity]::Creation($root.Handle)-ne $member[0].started-or $root.HasExited){throw 'Actual browser root creation identity changed'}
  $window=$root.MainWindowHandle
  $screen=[Windows.Forms.Screen]::FromHandle($window)
  $mode=[IfcFrameWindow]::Read($window,[uint32]$root.Id,$screen.DeviceName)
  $controllers=@(Get-CimInstance Win32_VideoController|ForEach-Object {@{name=$_.Name;device=$_.PNPDeviceID;driver=$_.DriverVersion}})
  $value=@{monitor=$screen.DeviceName;left=$screen.Bounds.Left;top=$screen.Bounds.Top;
    width=[int]$mode.width;height=[int]$mode.height;frequencyHz=[int]$mode.frequency;
    bitsPerPixel=[int]$mode.bits;orientation=[int]$mode.orientation;dpi=[int][IfcFrameWindow]::GetDpiForWindow($window);controllers=$controllers}
  if($root.HasExited-or [IfcProcessIdentity]::Creation($root.Handle)-ne $member[0].started){throw 'Browser exited while reading display'}
  @{output=$value;executableWin=$root.MainModule.FileName}|ConvertTo-Json -Depth 6 -Compress
} finally {$root.Dispose()}
`;
  const value: unknown = readPowerShellJson(script);
  if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'executableWin') !== 'string'
    || !Reflect.get(value, 'executableWin')) throw new Error('actual owned browser executable unavailable');
  return { output: decodeNativeOutput(Reflect.get(value, 'output')), executableWin: Reflect.get(value, 'executableWin') as string };
}
