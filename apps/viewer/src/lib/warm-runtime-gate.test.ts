/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Who may warm up before the first file (#9750). URL-only perf flags arrive as
// strings, so `?perf.warmShell=0` must switch a piece off: the first version
// compared against the number only, and its kill switch did nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayWarmUp } from './warm-runtime-gate.js';

const desktop = { deviceMemory: 8, connection: { saveData: false } } as unknown as Navigator;

test('the kill switch turns warm-up off in every spelling a flag can arrive in', () => {
  for (const off of ['0', 'false', 0, false]) assert.equal(mayWarmUp(off, desktop), false, String(off));
  for (const on of [undefined, null, '1', 1, true]) assert.equal(mayWarmUp(on, desktop), true, String(on));
});

test('a browser that asks to save data or reports under 4 GB is skipped; an unreported size is not', () => {
  assert.equal(mayWarmUp(undefined, { deviceMemory: 8, connection: { saveData: true } } as unknown as Navigator), false);
  assert.equal(mayWarmUp(undefined, { deviceMemory: 2 } as unknown as Navigator), false);
  assert.equal(mayWarmUp(undefined, { deviceMemory: 4 } as unknown as Navigator), true);
  assert.equal(mayWarmUp(undefined, {} as Navigator), true);
});
