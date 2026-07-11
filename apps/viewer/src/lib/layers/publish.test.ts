/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { getProvenance } from '@ifc-lite/ifcx';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { extractStackState } from '@ifc-lite/merge';
import type { Mutation } from '@ifc-lite/mutations';
import { BrowserLayerStore } from './browser-store.js';
import { publishViewerDraft } from './publish.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

function makeBase(): IfcxFile {
  return {
    header: {
      id: 'base-layer',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 't',
      timestamp: '2026-07-11T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data: [
      {
        path: 'wall-guid-1',
        attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: { type: 'IfcLabel', value: 'REI60' } },
      },
    ],
  };
}

function mutation(partial: Partial<Mutation>): Mutation {
  return {
    id: 'm1',
    type: 'UPDATE_PROPERTY',
    timestamp: 1,
    modelId: 'model-1',
    entityId: 7,
    ...partial,
  } as Mutation;
}

// Under node:test there is no indexedDB — the store runs memory-only,
// which exercises exactly the sync surface the merge engine consumes.
describe('publishViewerDraft (#1717 V2)', () => {
  it('freezes a property edit into a content-addressed, provenance-stamped layer on a ref', async () => {
    const store = await BrowserLayerStore.open();
    const base = makeBase();
    const result = publishViewerDraft({
      store,
      stackFiles: [base],
      mutations: [
        mutation({ psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
      ],
      pathOf: (id) => (id === 7 ? 'wall-guid-1' : undefined),
      intent: 'Raise fire rating',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });

    assert.ok(result.layerId.startsWith('blake3:'));
    assert.deepStrictEqual(result.unresolved, []);
    assert.deepStrictEqual(store.getRef('local')?.layers, [result.layerId]);

    const stored = store.loadLayer(result.layerId);
    const manifest = getProvenance(stored);
    assert.strictEqual(manifest?.author.principal, 'louis');
    assert.strictEqual(manifest?.intent, 'Raise fire rating');
    assert.strictEqual(manifest?.base?.kind, 'stack');

    // The layer composes: the merge engine sees the new value on top.
    const state = extractStackState([base, stored]);
    const pset = state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety');
    assert.deepStrictEqual(pset?.[FIRE], { type: 'IfcLabel', value: 'REI90' });
  });

  it('is deterministic: same edits, same created stamp, same content address', async () => {
    const store = await BrowserLayerStore.open();
    const init = {
      store,
      stackFiles: [makeBase()],
      mutations: [mutation({ psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' })],
      pathOf: () => 'wall-guid-1',
      intent: 'Raise fire rating',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    };
    const a = publishViewerDraft(init);
    const b = publishViewerDraft(init); // idempotent re-store, ref gains the id twice
    assert.strictEqual(a.layerId, b.layerId);
  });

  it('reports unresolved entities and refuses an empty layer', async () => {
    const store = await BrowserLayerStore.open();
    assert.throws(
      () =>
        publishViewerDraft({
          store,
          stackFiles: [makeBase()],
          mutations: [mutation({ psetName: 'Pset_X', propName: 'A', newValue: 1, entityId: 99 })],
          pathOf: () => undefined,
          intent: 'Nothing resolvable',
          authorPrincipal: 'louis',
          refName: 'local',
        }),
      /No publishable changes/,
    );
  });

  it('property deletion and attribute edits serialize as removal opinions and prop keys', async () => {
    const store = await BrowserLayerStore.open();
    const result = publishViewerDraft({
      store,
      stackFiles: [makeBase()],
      mutations: [
        mutation({ id: 'm1', type: 'DELETE_PROPERTY', psetName: 'Pset_FireSafety', propName: 'FireRating' }),
        mutation({ id: 'm2', type: 'UPDATE_ATTRIBUTE', attributeName: 'Name', newValue: 'Wall W1' }),
      ],
      pathOf: () => 'wall-guid-1',
      intent: 'Cleanup',
      authorPrincipal: 'louis',
      refName: 'local',
      created: '2026-07-11T12:00:00Z',
    });
    const node = result.file.data.find((n) => n.path === 'wall-guid-1');
    assert.strictEqual(node?.attributes?.[FIRE], null);
    // Core attributes stay raw — the entity/hierarchy extractors only
    // honor a plain string here.
    assert.strictEqual(node?.attributes?.['bsi::ifc::prop::Name'], 'Wall W1');
    // Composition drops the removed member.
    const state = extractStackState([makeBase(), result.file]);
    assert.strictEqual(state.get('wall-guid-1')?.components.get('pset:Pset_FireSafety'), undefined);
  });
});

describe('BrowserLayerStore integrity', () => {
  it('refuses a header id that does not match the content address', async () => {
    const store = await BrowserLayerStore.open();
    const bogus = { ...makeBase(), header: { ...makeBase().header, id: 'blake3:not-really' } };
    assert.throws(() => store.storeLayer(bogus), /does not match content address/);
  });
});
