/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Core `BrowserLayerStore` invariants that don't need IndexedDB at all
 * (memory-only here, `typeof indexedDB === 'undefined'` in this process):
 * the content-address conflict guard, `setRef`'s policy stripping, and
 * clone isolation on read. `readAll`/transaction-abort handling lives in
 * its own file (browser-store.test.ts) because it monkeypatches
 * `IDBCursor.prototype`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayerId, computeStackHash, createProvenanceManifest, setProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { BrowserLayerStore } from './browser-store.js';
import type { RefEntry } from '@ifc-lite/merge';

function publishable(data: IfcxNode[], intent: string, baseIds: string[] | null): IfcxFile {
  const bare: IfcxFile = {
    header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-08-23T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base: baseIds === null ? null : { kind: 'stack', id: computeStackHash(baseIds) },
    created: '2026-08-23T00:00:00Z',
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

describe('BrowserLayerStore.storeLayer content-address conflict guard', () => {
  it('is idempotent: storing byte-identical content twice returns the same id without throwing', async () => {
    const store = await BrowserLayerStore.open();
    const layer = publishable([{ path: 'wall-1', attributes: {} }], 'first store', null);
    const first = store.storeLayer(layer);
    const second = store.storeLayer(structuredClone(layer));
    assert.equal(second, first);
  });

  it('refuses a second layer at the same content address whose bytes actually differ', async () => {
    // `signatures` is deliberately excluded from the canonical hash
    // (canonicalizeLayer strips it so a layer can be verified against its
    // own id before it is signed) — so two objects can share a computed
    // content id while differing in their signature list. That is exactly
    // the case this guard exists for: silently accepting the second copy
    // would let a re-published layer swap in different signatures under a
    // content address the first copy already claimed.
    const store = await BrowserLayerStore.open();
    const base = publishable([{ path: 'wall-1', attributes: {} }], 'signed later', null);
    store.storeLayer(base);

    const manifestKey = Object.keys(base.header).find((k) => k.includes('provenance'));
    assert.ok(manifestKey, 'the provenance manifest is stored under a header key');
    const manifest = (base.header as unknown as Record<string, Record<string, unknown>>)[manifestKey!];
    const forged: IfcxFile = {
      ...base,
      header: {
        ...base.header,
        [manifestKey!]: { ...manifest, signatures: [{ alg: 'ed25519', key: 'k', sig: 's' }] },
      },
    };
    assert.equal(forged.header.id, base.header.id, 'content id is unchanged — signatures are outside the hash');
    assert.throws(
      () => store.storeLayer(forged),
      /already stored with different bytes/,
      'byte-different content under a shared address must be refused, not silently discarded',
    );
  });
});

describe('BrowserLayerStore.setRef policy handling', () => {
  it('keeps a truthy policy', async () => {
    const store = await BrowserLayerStore.open();
    const entry: RefEntry = { layers: [], policy: { requiredChecks: ['spec-a'] } };
    store.setRef('gated', entry);
    assert.deepEqual(store.getRef('gated'), entry);
  });

  it('strips an explicit undefined policy rather than storing it as a key', async () => {
    const store = await BrowserLayerStore.open();
    store.setRef('ungated', { layers: [], policy: undefined });
    const stored = store.getRef('ungated');
    assert.equal(stored && 'policy' in stored, false, 'an absent policy must not round-trip as an explicit undefined key');
  });
});

describe('BrowserLayerStore clone isolation', () => {
  it('getRef returns a clone: mutating the result does not affect the store', async () => {
    const store = await BrowserLayerStore.open();
    store.setRef('main', { layers: ['blake3:aaa'] });
    const first = store.getRef('main');
    first?.layers.push('blake3:bbb');
    const second = store.getRef('main');
    assert.deepEqual(second, { layers: ['blake3:aaa'] }, 'the mutation on the first read must not leak into the store');
  });

  it('loadLayer returns a clone: mutating the result does not affect a later loadLayer', async () => {
    const store = await BrowserLayerStore.open();
    const layer = publishable([{ path: 'wall-1', attributes: { x: 1 } }], 'clone check', null);
    store.storeLayer(layer);
    const first = store.loadLayer(layer.header.id);
    first.data[0]!.attributes = { x: 999 };
    const second = store.loadLayer(layer.header.id);
    assert.deepEqual(second.data[0]?.attributes, { x: 1 }, 'a caller mutating its loaded copy must not corrupt the stored layer');
  });
});
