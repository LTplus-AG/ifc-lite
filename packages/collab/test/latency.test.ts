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
});
