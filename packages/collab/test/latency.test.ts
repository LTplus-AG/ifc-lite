/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, setAttribute, getAttribute } from '../src/doc/entity.js';
import { createLatencyChannel } from '../src/perf/latency.js';

describe('latency simulator', () => {
  it('delivers updates only after their arrival time', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    const channel = createLatencyChannel(a, b, { baseMs: 100 });
    a.transact(() => createEntity(a, 'wall'));
    channel.initialSync();

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A1'));
    expect(getAttribute(b, 'wall', 'Name')).toBeUndefined(); // not delivered yet

    channel.flushUntil(50); // before arrivalTime
    expect(getAttribute(b, 'wall', 'Name')).toBeUndefined();
    channel.flushUntil(100); // at arrivalTime
    expect(getAttribute(b, 'wall', 'Name')).toBe('A1');
  });

  it('drops a deterministic fraction of updates', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    // Seedable PRNG so the test is stable.
    let seed = 1;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
    a.transact(() => createEntity(a, 'wall'));
    // Build the channel AFTER pre-existing state so we count only the
    // burst that follows.
    const channel = createLatencyChannel(a, b, { baseMs: 0, dropRate: 0.5, random: rand });
    channel.initialSync();

    for (let i = 0; i < 20; i++) {
      a.transact(() => setAttribute(a, 'wall', `K${i}`, i));
    }
    channel.flushUntil(1000);
    expect(channel.dropped()).toBeGreaterThan(0);
    expect(channel.delivered()).toBeGreaterThan(0);
    expect(channel.delivered() + channel.dropped()).toBe(20);
  });

  it('reaches eventual consistency once delivery completes', () => {
    const a = createCollabDoc();
    const b = createCollabDoc();
    const channel = createLatencyChannel(a, b, { baseMs: 25 });
    a.transact(() => createEntity(a, 'wall'));
    channel.initialSync();

    a.transact(() => setAttribute(a, 'wall', 'Name', 'A'));
    b.transact(() => setAttribute(b, 'wall', 'Description', 'from-B'));

    channel.flushUntil(1000);
    expect(getAttribute(a, 'wall', 'Description')).toBe('from-B');
    expect(getAttribute(b, 'wall', 'Name')).toBe('A');
  });

  it('delivers strictly in arrival-time order, not emission order (queue.sort in flushUntil)', () => {
    // Every other case in this file uses baseMs with no jitter, so every
    // queued item shares the same arrivesAt — `queue.sort` is comparing
    // equal keys throughout and a reversed comparator is indistinguishable
    // from the real one (both are valid orderings of an all-equal array).
    // We also can't just fire several updates from the SAME doc with
    // different jitter and check intermediate delivery: Yjs enforces
    // per-client causal (FIFO) order internally, so a later-clock update
    // from client `a` silently buffers until an earlier-clock update from
    // that same client has integrated — that would mask the sort bug
    // behind Yjs's own gap-filling, not exercise it. Instead we fire ONE
    // update from `a` and ONE from `b` (independent client clocks, no
    // causal dependency between them) with jitter forcing non-monotonic,
    // opposite-order arrival times, so which one is due first at a
    // half-way flush depends entirely on `queue.sort`.
    const a = createCollabDoc();
    const b = createCollabDoc();
    a.transact(() => createEntity(a, 'wall'));

    // `onA`/`onB` each call `rand()` twice: once for the drop check, once
    // for jitter. dropRate=0 so the drop check (0.5) never trips. Script
    // the jitter calls so `a`'s update arrives at +800 and `b`'s update
    // arrives at -800 (baseMs=0, jitterMs=1000, `now`=0 at emission time —
    // no flush has happened yet): jitter = (rand()*2-1)*jitterMs, so
    // rand=0.9 -> +800, rand=0.1 -> -800.
    const script = [0.5, 0.9, 0.5, 0.1];
    let i = 0;
    const rand = () => script[i++];

    const channel = createLatencyChannel(a, b, { baseMs: 0, jitterMs: 1000, dropRate: 0, random: rand });
    channel.initialSync();

    a.transact(() => setAttribute(a, 'wall', 'FromA', 'vA')); // -> b, arrivesAt +800
    b.transact(() => setAttribute(b, 'wall', 'FromB', 'vB')); // -> a, arrivesAt -800

    // Flush to 300: only the -800 entry (b -> a) is due; the +800 entry
    // (a -> b) must stay queued. The correct ascending sort puts the -800
    // entry at queue[0] and delivers it, then stops at the +800 entry. A
    // comparator reversed to descending order puts the +800 entry at
    // queue[0] instead; since `flushUntil`'s while loop only ever inspects
    // queue[0], that alone (800 > 300) halts delivery immediately and
    // drops the count to 0 even though the -800 entry is due — the
    // discriminating signal below.
    channel.flushUntil(300);
    expect(channel.delivered()).toBe(1);
    expect(getAttribute(a, 'wall', 'FromB')).toBe('vB');
    expect(getAttribute(b, 'wall', 'FromA')).toBeUndefined();

    channel.flushUntil(800);
    expect(channel.delivered()).toBe(2);
    expect(getAttribute(b, 'wall', 'FromA')).toBe('vA');
  });
});
