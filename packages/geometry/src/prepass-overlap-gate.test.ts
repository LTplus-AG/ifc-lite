/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  PREPASS_OVERLAP_GATE_MIN_BYTES,
  PoolSetupBroadcast,
  holdsPoolUntilPrepassEnds,
} from './prepass-overlap-gate.js';

const MB = 1024 * 1024;

describe('holdsPoolUntilPrepassEnds (#10264)', () => {
  it('gates at 512 MiB and above, never below', () => {
    expect(PREPASS_OVERLAP_GATE_MIN_BYTES).toBe(512 * MB);
    expect(holdsPoolUntilPrepassEnds(PREPASS_OVERLAP_GATE_MIN_BYTES - 1)).toBe(false);
    expect(holdsPoolUntilPrepassEnds(PREPASS_OVERLAP_GATE_MIN_BYTES)).toBe(true);
    expect(holdsPoolUntilPrepassEnds(1200 * MB)).toBe(true);
  });

  it('keeps the load-time goal fixtures (20, 177 and 343 MB) on the ungated path', () => {
    for (const mb of [20, 177, 343]) expect(holdsPoolUntilPrepassEnds(mb * MB)).toBe(false);
  });
});

/** Records which setup reached which worker, in global order. */
function fakePool(n: number): { workers: Worker[]; seen: string[] } {
  const seen: string[] = [];
  const workers = Array.from({ length: n }, (_, i) => ({ name: `w${i}` }) as unknown as Worker);
  return { workers, seen };
}
const setupNamed = (seen: string[], name: string) => (w: Worker) => {
  seen.push(`${(w as unknown as { name: string }).name}:${name}`);
};

describe('PoolSetupBroadcast (#10264)', () => {
  it('posts each setup to every worker immediately when not holding', () => {
    const { workers, seen } = fakePool(2);
    const b = new PoolSetupBroadcast(workers, false);
    expect(b.holding).toBe(false);
    b.broadcast(setupNamed(seen, 'stream-start'));
    expect(seen).toEqual(['w0:stream-start', 'w1:stream-start']);
    expect(b.log).toHaveLength(1);
  });

  it('holds every setup until release, then posts them in their original order', () => {
    const { workers, seen } = fakePool(2);
    const b = new PoolSetupBroadcast(workers, true);
    for (const name of ['stream-start', 'set-entity-index', 'set-styles']) b.broadcast(setupNamed(seen, name));
    expect(b.holding).toBe(true);
    expect(seen).toEqual([]);
    // The replay log still records them, for a replacement worker.
    expect(b.log).toHaveLength(3);

    b.release();
    expect(b.holding).toBe(false);
    expect(seen).toEqual([
      'w0:stream-start', 'w1:stream-start',
      'w0:set-entity-index', 'w1:set-entity-index',
      'w0:set-styles', 'w1:set-styles',
    ]);
  });

  it('passes setups through after release, and a second release posts nothing again', () => {
    const { workers, seen } = fakePool(1);
    const b = new PoolSetupBroadcast(workers, true);
    b.broadcast(setupNamed(seen, 'stream-start'));
    b.release();
    b.release();
    b.broadcast(setupNamed(seen, 'set-prepass-columns'));
    expect(seen).toEqual(['w0:stream-start', 'w0:set-prepass-columns']);
  });

  it('reaches workers added to the pool before release (the pool fills the array after construction)', () => {
    const workers: Worker[] = [];
    const seen: string[] = [];
    const b = new PoolSetupBroadcast(workers, true);
    workers.push({ name: 'w0' } as unknown as Worker);
    b.broadcast(setupNamed(seen, 'stream-start'));
    b.release();
    expect(seen).toEqual(['w0:stream-start']);
  });
});
