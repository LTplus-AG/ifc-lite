/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention, planRetention } from '../src/retention.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-retention-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function touch(file: string, ageDays: number, bytes = 16) {
  const p = path.join(tmpDir, file);
  fs.writeFileSync(p, Buffer.alloc(bytes));
  const t = Date.now() - ageDays * 24 * 60 * 60 * 1000;
  fs.utimesSync(p, t / 1000, t / 1000);
}

describe('retention', () => {
  it('keeps active log; drops rotated logs older than fullLogDays', async () => {
    touch('room.log', 0); // active, never dropped
    touch('room.log.2025-01-01', 95); // rotated, beyond default 90 days
    touch('room.log.2026-04-01', 30); // rotated, fresh
    touch('room.snap.2024-01-01', 95); // snapshot, well within 5y default

    const decision = planRetention(tmpDir);
    expect(decision.drop.map((p) => path.basename(p))).toEqual(['room.log.2025-01-01']);
    expect(decision.reclaimBytes).toBeGreaterThan(0);

    const freed = await applyRetention(decision);
    expect(freed).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(tmpDir, 'room.log'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'room.log.2025-01-01'))).toBe(false);
  });

  it('respects maxBytesPerRoom by trimming oldest first', () => {
    touch('a.log.2024-01-01', 5, 1000);
    touch('a.log.2024-06-01', 4, 1000);
    touch('a.log.2025-01-01', 3, 1000);
    const decision = planRetention(tmpDir, { fullLogDays: 9999, maxBytesPerRoom: 1500 });
    // Should drop the two oldest until under 1500 bytes.
    expect(decision.drop.map((p) => path.basename(p)).sort()).toEqual([
      'a.log.2024-01-01',
      'a.log.2024-06-01',
    ]);
  });
});
