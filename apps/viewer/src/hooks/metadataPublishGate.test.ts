/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { createMetadataPublishGate as CreateGate } from './metadataPublishGate.js';

/** Loaded at runtime so a build without the gate fails these assertions instead of failing to load (revert oracle). */
async function loadGate(): Promise<typeof CreateGate> {
  const mod = (await import('./metadataPublishGate.js').catch(() => null)) as Record<string, unknown> | null;
  assert.equal(typeof mod?.createMetadataPublishGate, 'function', 'metadataPublishGate.ts must export createMetadataPublishGate');
  return mod!.createMetadataPublishGate as typeof CreateGate;
}

/** Manual clock + timer queue, so every test decides exactly when the tail ends. */
async function harness(maxHoldMs = 3_000) {
  const createMetadataPublishGate = await loadGate();
  let busy = false;
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const published: string[] = [];
  const gate = createMetadataPublishGate<string>({
    isTailBusy: () => busy,
    publishPartial: (s) => published.push(`partial:${s}`),
    publishFull: (s) => published.push(`full:${s}`),
    pollMs: 16,
    maxHoldMs,
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); },
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift(); t = next.at; next.fn();
    }
    t = end;
  };
  return { gate, published, advance, setBusy: (b: boolean) => { busy = b; }, pendingTimers: () => timers.length };
}

describe('createMetadataPublishGate', () => {
  it('publishes both stores immediately when no geometry tail is running', async () => {
    const h = await harness();
    h.gate.partial('p'); h.gate.full('f');
    assert.deepEqual(h.published, ['partial:p', 'full:f']);
    assert.equal(h.pendingTimers(), 0, 'nothing held, nothing polled');
  });

  it('holds a store during the tail and publishes only the full one when it overtook the partial', async () => {
    const h = await harness();
    h.setBusy(true);
    h.gate.partial('p');
    h.advance(100);
    h.gate.full('f');
    h.advance(100);
    assert.deepEqual(h.published, [], 'nothing may land inside the tail');
    h.setBusy(false);
    h.advance(16);
    assert.deepEqual(h.published, ['full:f'], 'the discarded partial must not cost a publication');
    h.advance(1_000);
    assert.deepEqual(h.published, ['full:f'], 'published exactly once');
  });

  it('releases a held partial when the tail ends, then lets the full store straight through', async () => {
    const h = await harness();
    h.setBusy(true);
    h.gate.partial('p');
    h.setBusy(false);
    h.advance(16);
    assert.deepEqual(h.published, ['partial:p']);
    h.gate.full('f');
    assert.deepEqual(h.published, ['partial:p', 'full:f']);
  });

  it('a full store that arrives after the partial was released during a new busy window is held, not lost', async () => {
    const h = await harness();
    h.setBusy(true); h.gate.partial('p'); h.setBusy(false); h.advance(16);
    h.setBusy(true); h.gate.full('f');
    assert.deepEqual(h.published, ['partial:p']);
    h.setBusy(false); h.advance(16);
    assert.deepEqual(h.published, ['partial:p', 'full:f']);
  });

  it('never parks metadata behind a finalize that does not end', async () => {
    const h = await harness(3_000);
    h.setBusy(true);
    h.gate.full('f');
    h.advance(2_990);
    assert.deepEqual(h.published, []);
    h.advance(40);
    assert.deepEqual(h.published, ['full:f'], 'released by the hold limit while still busy');
  });

  it('ignores a late partial after the full store', async () => {
    const h = await harness();
    h.gate.full('f'); h.gate.partial('late');
    assert.deepEqual(h.published, ['full:f']);
  });
});
