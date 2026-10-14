/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readInputIdleReceipt, inputIdleMs, requireInputIdle } from './frame-gpu-input-idle.js';
import { readPhysicalSession, readPowerShellJson } from './frame-gpu-session.js';
import { decodeNativeOutput } from './frame-gpu-night-admission.js';

// #6975: actual session queries and an owned hidden CPU window; no Chrome,
// injected input, display changes, GPU startup, or physical-night admission.
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8', timeout: 10_000,
});
const skip = probe.error || probe.status !== 0 ? 'Actual Windows PowerShell unavailable; provider qualification held' : false;

test('#6975 actual input provider reports the querying Windows session and refuses another session', { skip }, (context) => {
  const session = readPhysicalSession();
  const first = readInputIdleReceipt(), second = readInputIdleReceipt();
  assert.equal(first.session, session.currentSession);
  assert.equal(second.session, session.currentSession);
  assert.ok(BigInt(second.uptimeMs) >= BigInt(first.uptimeMs));
  // User input can legitimately arrive between observations. No monotonic
  // idle-age assumption and no input injection are used by this control.
  const age = inputIdleMs(second);
  const refusalMinimum = Math.floor(age / 1000) + 1;
  context.diagnostic(JSON.stringify({ session, first, second, ageMs: age, refusalMinimumSeconds: refusalMinimum }));
  assert.throws(() => requireInputIdle(second, session.currentSession, refusalMinimum), /recent user input/);
  assert.throws(() => requireInputIdle(second, session.currentSession + 1, refusalMinimum), /another Windows session/);
});

const provider = readFileSync(new URL('./frame-gpu-window-profile.ps1', import.meta.url), 'utf8');
const windowProbe = `
$ErrorActionPreference = 'Stop'
${provider}
$form = New-Object Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.Text = 'ifc-lite owned CPU provider control'
try {
  # Allocates an owned HWND without Show()/Activate(); no foreground change.
  $window = $form.Handle
  $ownerPid = [uint32][Diagnostics.Process]::GetCurrentProcess().Id
  $screen = [Windows.Forms.Screen]::FromHandle($window)
  $mode = [IfcFrameWindow]::Read($window, $ownerPid, $screen.DeviceName)
  $dpi = [IfcFrameWindow]::GetDpiForWindow($window)
  $refusals = @{}
  foreach ($control in @('zero', 'wrong-owner', 'invalid-device')) {
    try {
      if ($control -eq 'zero') { $null = [IfcFrameWindow]::Read([IntPtr]::Zero, $ownerPid, $screen.DeviceName) }
      elseif ($control -eq 'wrong-owner') { $null = [IfcFrameWindow]::Read($window, ($ownerPid + 1), $screen.DeviceName) }
      else { $null = [IfcFrameWindow]::Read($window, $ownerPid, 'ifc-lite-invalid-display-device') }
      $refusals[$control] = @{ refused = $false }
    } catch { $refusals[$control] = @{ refused = $true; error = $_.Exception.Message } }
  }
  $controllers = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    @{ name = $_.Name; device = $_.PNPDeviceID; driver = $_.DriverVersion }
  })
  $form.Dispose()
  try {
    $null = [IfcFrameWindow]::Read($window, $ownerPid, $screen.DeviceName)
    $refusals['destroyed'] = @{ refused = $false }
  } catch { $refusals['destroyed'] = @{ refused = $true; error = $_.Exception.Message } }
  @{
    hidden = -not $form.Visible
    disposed = $form.IsDisposed
    output = @{
      monitor = $screen.DeviceName; left = $screen.Bounds.Left; top = $screen.Bounds.Top
      width = $mode.width; height = $mode.height; frequencyHz = $mode.frequency
      bitsPerPixel = $mode.bits; orientation = $mode.orientation; dpi = $dpi
      controllers = $controllers
    }
    refusals = $refusals
  } | ConvertTo-Json -Depth 8 -Compress
} finally { $form.Dispose() }
`;

test('#6975 actual owned hidden HWND reads Win32 display fields and rejects invalid ownership/device/retired HWND', { skip }, (context) => {
  const raw = readPowerShellJson(windowProbe);
  context.diagnostic(JSON.stringify(raw));
  assert.ok(raw && typeof raw === 'object');
  assert.equal(Reflect.get(raw, 'hidden'), true);
  assert.equal(Reflect.get(raw, 'disposed'), true);
  const output = decodeNativeOutput(Reflect.get(raw, 'output'));
  assert.ok(output.width > 0 && output.height > 0 && output.dpi > 0);
  const refusals: unknown = Reflect.get(raw, 'refusals');
  assert.ok(refusals && typeof refusals === 'object');
  for (const control of ['zero', 'wrong-owner', 'invalid-device', 'destroyed']) {
    const row: unknown = Reflect.get(refusals, control);
    assert.ok(row && typeof row === 'object');
    assert.equal(Reflect.get(row, 'refused'), true, control);
    assert.equal(typeof Reflect.get(row, 'error'), 'string', control);
  }
});
