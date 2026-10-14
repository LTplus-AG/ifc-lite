/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeInputIdleReceipt, inputIdleMs, requireInputIdle, type InputIdleReceipt } from './frame-gpu-input-idle.js';

// Win32 tick/validation invariants. These are not real user-idle/native-night receipts.
const receipt = (uptimeMs: string, lastInputTick: number): InputIdleReceipt => ({
  capturedAt: '2026-10-08T02:00:00Z', session: 3, uptimeMs, lastInputTick,
});

test('#6975 input-age guard handles genuine 32-bit rollover without admitting future ticks', () => {
  assert.equal(inputIdleMs(receipt('4294967496', 4294967196)), 300);
  assert.throws(() => inputIdleMs(receipt('1000', 1001)), /ahead/);
  assert.throws(() => inputIdleMs(receipt('4294968296', 1001)), /ambiguous/);
  assert.throws(() => inputIdleMs(receipt('2147483648', 0)), /ambiguous/);
});

test('#6975 explicit user-idle minimum and current session must both match before launch', () => {
  requireInputIdle(receipt('1000000', 600000), 3, 300);
  assert.throws(() => requireInputIdle(receipt('1000000', 900000), 3, 300), /recent user input/);
  assert.throws(() => requireInputIdle(receipt('1000000', 600000), 4, 300), /another Windows session/);
  for (const minimum of [0, -1, Number.NaN, 0.5]) assert.throws(() => requireInputIdle(receipt('1000000', 600000), 3, minimum));
});

test('#6975 missing or malformed raw input telemetry never becomes fabricated idle', () => {
  for (const invalid of [
    { lastInputTick: null }, { lastInputTick: '0' }, { lastInputTick: 4294967296 },
    { uptimeMs: null }, { uptimeMs: '18446744073709551616' }, { uptimeMs: '-1' },
    { session: null }, { capturedAt: 'unobserved' },
  ]) assert.throws(() => decodeInputIdleReceipt({ ...receipt('1000000', 600000), ...invalid }));
});
