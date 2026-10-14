/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readPowerShellJson } from './frame-gpu-session.js';

export interface InputIdleReceipt {
  capturedAt: string;
  session: number;
  uptimeMs: string;
  lastInputTick: number;
}

/** Session-specific read-only input timing. No key/pointer content is collected. */
export function readInputIdleReceipt(): InputIdleReceipt {
  return decodeInputIdleReceipt(readPowerShellJson(`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IfcFrameInput {
  [StructLayout(LayoutKind.Sequential)] public struct LastInput { public uint size; public uint tick; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetLastInputInfo(ref LastInput value);
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
  public static uint Read() {
    LastInput value = new LastInput(); value.size = (uint)Marshal.SizeOf(typeof(LastInput));
    if (!GetLastInputInfo(ref value)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return value.tick;
  }
}
'@
$last = [IfcFrameInput]::Read()
@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  lastInputTick = $last
  uptimeMs = ([IfcFrameInput]::GetTickCount64()).ToString([Globalization.CultureInfo]::InvariantCulture)
} | ConvertTo-Json -Compress
`));
}

export function decodeInputIdleReceipt(value: unknown): InputIdleReceipt {
  if (!value || typeof value !== 'object') throw new Error('missing input-idle observation');
  const time: unknown = Reflect.get(value, 'capturedAt');
  const session: unknown = Reflect.get(value, 'session');
  const uptime: unknown = Reflect.get(value, 'uptimeMs');
  const tick: unknown = Reflect.get(value, 'lastInputTick');
  if (typeof time !== 'string' || !Number.isFinite(Date.parse(time))
    || typeof session !== 'number' || !Number.isInteger(session) || session < 0
    || typeof uptime !== 'string' || !/^\d{1,20}$/.test(uptime) || BigInt(uptime) > 0xffff_ffff_ffff_ffffn
    || typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || tick > 0xffffffff) {
    throw new Error('invalid input-idle observation');
  }
  return value as InputIdleReceipt;
}

/**
 * 32-bit input ticks can wrap and SendInput can supply nonincremental ticks.
 * Refuse future/half-cycle-ambiguous observations rather than calling them idle.
 * The explicit configured minimum is user-activity policy, not a GPU threshold.
 */
export function inputIdleMs(receipt: InputIdleReceipt): number {
  decodeInputIdleReceipt(receipt);
  const uptime = BigInt(receipt.uptimeMs), last = BigInt(receipt.lastInputTick);
  const cycle = 0x1_0000_0000n;
  if (uptime < cycle && last > uptime) throw new Error('input tick is ahead of system uptime');
  const elapsed = (uptime % cycle - last + cycle) % cycle;
  if (elapsed >= cycle / 2n) throw new Error('ambiguous input tick age');
  return Number(elapsed);
}

export function requireInputIdle(receipt: InputIdleReceipt, session: number, minimumSeconds: number): void {
  if (!Number.isInteger(minimumSeconds) || minimumSeconds <= 0) throw new Error('explicit positive user-idle minimum required');
  if (receipt.session !== session) throw new Error('input observation belongs to another Windows session');
  if (inputIdleMs(receipt) < minimumSeconds * 1000) throw new Error('recent user input refuses nightly browser startup');
}
