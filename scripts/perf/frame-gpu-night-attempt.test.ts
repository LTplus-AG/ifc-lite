/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginNightAttempt, finishNightAttempt, readNightAttempts } from './frame-gpu-night-attempt.js';
import { nightHistoryWindow } from './frame-gpu-night-history.js';

const profile = 'a'.repeat(64), start = new Date('2026-10-08T01:00:00Z');
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), '6975-attempt-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('#6975 interruption remains failed and the same UTC date cannot launch again', () => fixture((root) => {
  const first = beginNightAttempt(root, profile, start);
  assert.equal(first.mayLaunch, true);
  assert.equal(readNightAttempts(root)[0].status, 'failed');
  const second = beginNightAttempt(root, profile, new Date('2026-10-08T23:59:00Z'));
  assert.equal(second.mayLaunch, false);
  assert.throws(() => finishNightAttempt(second, 'ok', Buffer.from('retry')), /cannot be upgraded/);
  const history = readNightAttempts(root);
  assert.deepEqual(history.map((row) => row.status).sort(), ['failed', 'refused']);
  assert.equal(nightHistoryWindow(history, '2026-10-08').reason, 'multiple attempts on one night');
}));

test('#6975 completion retains a refusal and forbids replacing it with a successful retry', () => fixture((root) => {
  const handle = beginNightAttempt(root, profile, start);
  const completed = finishNightAttempt(handle, 'refused', Buffer.from('actual admission refusal'), new Date('2026-10-08T01:01:00Z'));
  assert.deepEqual(readNightAttempts(root), [completed]);
  assert.throws(() => finishNightAttempt(handle, 'ok', Buffer.from('retry'), new Date('2026-10-08T01:02:00Z')), /EEXIST/);
  assert.equal(readNightAttempts(root)[0].status, 'refused');
  assert.equal(beginNightAttempt(root, profile, new Date('2026-10-09T01:00:00Z')).mayLaunch, true);
}));

test('#6975 altered raw receipts and backwards completion timestamps refuse history', () => fixture((root) => {
  const handle = beginNightAttempt(root, profile, start);
  assert.throws(() => finishNightAttempt(handle, 'ok', Buffer.from('raw'), new Date('2026-10-08T00:59:00Z')), /invalid attempt interval/);
  finishNightAttempt(handle, 'failed', Buffer.from('raw failure'), new Date('2026-10-08T01:02:00Z'));
  writeFileSync(join(handle.directory, 'completed-receipt.json'), 'altered');
  assert.throws(() => readNightAttempts(root), /raw receipt changed/);
}));
