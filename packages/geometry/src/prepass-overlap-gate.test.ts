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
  const T = PREPASS_OVERLAP_GATE_MIN_BYTES;

  it('gates a 1-worker plan at 512 MiB and above, never below', () => {
    expect(T).toBe(512 * MB);
    expect(holdsPoolUntilPrepassEnds(T - 1, 1)).toBe(false);
    expect(holdsPoolUntilPrepassEnds(T, 1)).toBe(true);
    expect(holdsPoolUntilPrepassEnds(1200 * MB, 1)).toBe(true);
  });

  it('never gates a plan with 2 or more workers, at any size (main path, sharded scan included)', () => {
    for (const workers of [2, 3, 4, 8]) {
      expect(holdsPoolUntilPrepassEnds(T, workers)).toBe(false);
      expect(holdsPoolUntilPrepassEnds(2048 * MB, workers)).toBe(false);
    }
  });

  it('does not gate a pool with no workers', () => {
    expect(holdsPoolUntilPrepassEnds(2048 * MB, 0)).toBe(false);
  });

  it('keeps the load-time goal fixtures (20, 177 and 343 MB) on the ungated path at any worker count', () => {
    for (const mb of [20, 177, 343]) {
      for (const workers of [1, 2, 4]) expect(holdsPoolUntilPrepassEnds(mb * MB, workers)).toBe(false);
    }
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
  });

  it('holds every setup until release, then posts them in their original order', () => {
    const { workers, seen } = fakePool(2);
    const b = new PoolSetupBroadcast(workers, true);
    for (const name of ['stream-start', 'set-entity-index', 'set-styles']) b.broadcast(setupNamed(seen, name));
    expect(b.holding).toBe(true);
    expect(seen).toEqual([]);

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

  it('replays only released setups to a replacement, so release never delivers one twice', () => {
    const workers: Worker[] = [{ name: 'w0' } as unknown as Worker];
    const seen: string[] = [];
    const b = new PoolSetupBroadcast(workers, true);
    b.record(setupNamed(seen, 'init'));
    b.broadcast(setupNamed(seen, 'stream-start'));
    b.broadcast(setupNamed(seen, 'set-entity-index'));

    // A replacement joins the pool while it holds (the pool swaps it in place).
    const replacement = { name: 'r0' } as unknown as Worker;
    workers[0] = replacement;
    b.replayTo(replacement);
    expect(seen).toEqual(['r0:init']);

    b.release();
    expect(seen).toEqual(['r0:init', 'r0:stream-start', 'r0:set-entity-index']);

    // After release, a later replacement gets the whole log exactly once.
    const late = { name: 'r1' } as unknown as Worker;
    workers[0] = late;
    b.replayTo(late);
    expect(seen.filter((e) => e.startsWith('r1:'))).toEqual(['r1:init', 'r1:stream-start', 'r1:set-entity-index']);
  });

  it('replays nothing after clear()', () => {
    const seen: string[] = [];
    const b = new PoolSetupBroadcast([], false);
    b.record(setupNamed(seen, 'init'));
    b.clear();
    b.replayTo({ name: 'w0' } as unknown as Worker);
    expect(seen).toEqual([]);
  });
});
