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

describe('holdsMetadataDuringTail (small loads publish at once)', () => {
  it('holds only from the large-load boundary up', async () => {
    const mod = (await import('./metadataPublishGate.js').catch(() => null)) as Record<string, unknown> | null;
    assert.equal(typeof mod?.holdsMetadataDuringTail, 'function', 'metadataPublishGate.ts must export holdsMetadataDuringTail');
    const holds = mod!.holdsMetadataDuringTail as (mb: number) => boolean;
    const boundary = mod!.METADATA_HOLD_MIN_MB as number;
    assert.equal(boundary, 32);
    assert.equal(holds(boundary - 0.01), false, 'just below the boundary: publish at once');
    assert.equal(holds(boundary), true, 'at the boundary: hold during the tail');
    for (const mb of [2.3, 2.4, 3.8, 10]) assert.equal(holds(mb), false, `${mb} MB (duplex, FZK, Office_A, fast-path limit) publishes at once`);
    for (const mb of [35, 169, 327]) assert.equal(holds(mb), true, `${mb} MB (advanced_model, Holter, BWK) is held`);
  });
});

type GateModule = typeof import('./metadataPublishGate.js');
/** The whole module, loaded at runtime with every export the loader uses asserted (revert oracle). */
async function loadModule(): Promise<GateModule> {
  const mod = (await import('./metadataPublishGate.js').catch(() => null)) as Record<string, unknown> | null;
  for (const name of ['createMetadataPublishGate', 'loaderHoldsMetadata', 'heldStoreTargetsClosedModel']) {
    assert.equal(typeof mod?.[name], 'function', `metadataPublishGate.ts must export ${name}`);
  }
  return mod as unknown as GateModule;
}

describe('arrival milestones and the published flag', () => {
  it('reports each store when it ARRIVES, held or not, and marks a publication from the release as held', async () => {
    const { createMetadataPublishGate } = await loadModule();
    let busy = true, t = 0;
    const timers: Array<() => void> = [];
    const log: string[] = [];
    const gate = createMetadataPublishGate<string>({
      isTailBusy: () => busy,
      onArrive: (kind) => log.push(`arrive:${kind}@${t}`),
      publishPartial: (s, held) => log.push(`partial:${s}:${held}@${t}`),
      publishFull: (s, held) => log.push(`full:${s}:${held}@${t}`),
      now: () => t,
      setTimer: (fn) => { timers.push(fn); },
    });
    gate.partial('p');
    t = 10; gate.full('f');
    assert.deepEqual(log, ['arrive:partial@0', 'arrive:full@10'], 'stamped on arrival, while both are held');
    t = 50; busy = false;
    timers.shift()!();
    assert.deepEqual(log.slice(2), ['full:f:true@50'], 'the release publishes the newest store, flagged held');

    const direct: string[] = [];
    const open = createMetadataPublishGate<string>({
      isTailBusy: () => false, onArrive: (k) => direct.push(`arrive:${k}`),
      publishPartial: (s, held) => direct.push(`partial:${held}`), publishFull: (s, held) => direct.push(`full:${held}`),
    });
    open.partial('p'); open.full('f');
    assert.deepEqual(direct, ['arrive:partial', 'partial:false', 'arrive:full', 'full:false'], 'unheld: arrival then publication, not held');
  });
});

describe('loader wiring (useIfcLoader.ts)', () => {
  it('holds only a large primary load, after its stream completed, while it is current and its tail runs', async () => {
    const { loaderHoldsMetadata, METADATA_HOLD_MIN_MB } = await loadModule();
    const base = { fileSizeMB: METADATA_HOLD_MIN_MB, primary: true, streamComplete: true, stale: false };
    assert.equal(loaderHoldsMetadata(base, () => true), true);
    assert.equal(loaderHoldsMetadata(base, () => false), false, 'no tail: publish at once');
    assert.equal(loaderHoldsMetadata({ ...base, fileSizeMB: METADATA_HOLD_MIN_MB - 0.01 }, () => true), false, 'small load (file.size)');
    assert.equal(loaderHoldsMetadata({ ...base, primary: false }, () => true), false, 'federated add');
    assert.equal(loaderHoldsMetadata({ ...base, streamComplete: false }, () => true), false, 'still streaming: no tail yet');
    assert.equal(loaderHoldsMetadata({ ...base, stale: true }, () => true), false, 'stale load');
    let asked = false;
    loaderHoldsMetadata({ ...base, primary: false }, () => { asked = true; return true; });
    assert.equal(asked, false, 'the scene is not queried for a load that cannot be held');
  });

  it('a load that goes stale during the hold is released at the next poll and writes nothing', async () => {
    const { createMetadataPublishGate, loaderHoldsMetadata } = await loadModule();
    const state = { fileSizeMB: 177, primary: true, streamComplete: true, stale: false };
    let t = 0;
    const timers: Array<() => void> = [];
    const written: string[] = [];
    // The loader's publications return early on a stale load (onPartialDataStore / onFullDataStore).
    const publish = (s: string) => { if (!state.stale) written.push(s); };
    const gate = createMetadataPublishGate<string>({
      isTailBusy: () => loaderHoldsMetadata(state, () => true),
      publishPartial: publish, publishFull: publish, now: () => t, setTimer: (fn) => { timers.push(fn); },
    });
    gate.full('f');
    assert.deepEqual(written, []);
    state.stale = true; // superseded or cancelled while held
    t = 16; timers.shift()!();
    assert.equal(timers.length, 0, 'released at once, not after the 3 s limit');
    assert.deepEqual(written, [], 'nothing reaches the store of a stale load');
  });

  it('a primary model closed during the hold does not get its held store written; unheld stores publish as on main', async () => {
    const { heldStoreTargetsClosedModel } = await loadModule();
    assert.equal(heldStoreTargetsClosedModel(true, true, false), true, 'held, primary, closed: skip the active-store write');
    assert.equal(heldStoreTargetsClosedModel(true, true, true), false, 'held, still open: publish');
    assert.equal(heldStoreTargetsClosedModel(false, true, false), false, 'unheld (arrived before the tail): unchanged from main');
    assert.equal(heldStoreTargetsClosedModel(true, false, false), false, 'federated publishes through finalize');
  });
});
