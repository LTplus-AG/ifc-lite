/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10018: the physical-object count on a store whose rows are a table rather than STEP records.
 *
 * `collectEffectivePhysicalEntityIds` narrows the canonical enumeration to the physical classes
 * it finds in the source, and took that class list from `entityIndex.byType`, which a tabular
 * store leaves empty. It therefore asked for no class at all and returned an empty set, so the
 * model metadata panel reported "Elements with Geometry: 0" for every IFCX model.
 *
 * Expected counts here are derived from the entity table directly, never from the function
 * under test: the table is the store's row list, so walking it and applying
 * `isPhysicalObjectType` is an independent answer to the same question.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';

import { isPhysicalObjectType, collectEffectivePhysicalEntityIds } from './physical-objects.js';
import { collectMeshedIds } from './object-count.js';
import { computeModelStats } from '@/components/viewer/properties/modelMetadataStats.js';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest.js';
import { tabularFixtureStore, PROXY_A, PROXY_B, WALL } from '@/test/tabular-store-fixture.js';

const IFCX_FIXTURE = new URL('../../../../tests/models/ifc5/Hello_Wall_hello-wall.ifcx', import.meta.url);
const STEP_FIXTURE = new URL('../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);

/** The fixture bytes, or `null` when they were never fetched (`pnpm fixtures`). */
async function fixtureBytes(path: URL): Promise<ArrayBuffer | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  // `Buffer#buffer` is `ArrayBufferLike`, so copy the view's bytes into a plain ArrayBuffer.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** The store's physical rows, read off its entity table rather than through the code under test. */
function physicalRowsOfTable(store: IfcDataStore): Set<number> {
  const ids = new Set<number>();
  for (const expressId of store.entities.expressId) {
    if (!expressId) continue;
    if (isPhysicalObjectType(store.entities.getTypeName(expressId))) ids.add(expressId);
  }
  return ids;
}

const sorted = (ids: Iterable<number>) => [...ids].sort((a, b) => a - b);

describe('collectEffectivePhysicalEntityIds on a tabular store (#10018)', () => {
  it('counts the physical rows of a real IFCX model, and the panel reports those with geometry', async (t) => {
    const buffer = await fixtureBytes(IFCX_FIXTURE);
    if (!buffer) {
      t.skip('tests/models/ifc5/Hello_Wall_hello-wall.ifcx missing — run `pnpm fixtures`');
      return;
    }
    const payload = await parseIfcxViewerModel(buffer);
    const store = payload.dataStore;
    assert.equal(store.sourceKind, 'tabular');
    assert.equal(store.entityIndex.byType.size, 0, 'an IFCX store has no STEP type index');

    const expected = physicalRowsOfTable(store);
    assert.ok(expected.size > 0, 'the fixture holds physical elements to count');
    assert.deepEqual(sorted(collectEffectivePhysicalEntityIds(store, null)), sorted(expected));

    // The user-visible row the bug was reported against. Its own expected value: the physical
    // rows above that produced a mesh, intersected here rather than taken from the panel.
    const meshed = collectMeshedIds(payload.geometryResult);
    const expectedWithGeometry = [...expected].filter((id) => meshed.has(id)).length;
    assert.ok(expectedWithGeometry > 0, 'the fixture meshes some of its physical elements');
    const stats = computeModelStats(store, payload.geometryResult, {
      geometryReady: true,
      toLocalId: (globalId) => globalId,
    });
    assert.equal(stats.elementsWithGeometry, expectedWithGeometry);
  });

  it('counts the physical rows of a hand-built tabular store labelled IFC4', () => {
    // The marker is `sourceKind`, not the schema label: an IFC4-labelled store with no STEP
    // records must be enumerated from its table just the same.
    const store = tabularFixtureStore();
    assert.equal(store.schemaVersion, 'IFC4');
    assert.equal(store.sourceKind, 'tabular');
    assert.deepEqual(sorted(physicalRowsOfTable(store)), [PROXY_A, PROXY_B, WALL]);
    assert.deepEqual(sorted(collectEffectivePhysicalEntityIds(store, null)), [PROXY_A, PROXY_B, WALL]);
  });

  it('leaves a STEP store counting its type index, unchanged', async (t) => {
    const buffer = await fixtureBytes(STEP_FIXTURE);
    if (!buffer) {
      t.skip('tests/models/ara3d/AC20-FZK-Haus.ifc missing — run `pnpm fixtures`');
      return;
    }
    const store = await new IfcParser().parseColumnar(buffer, { disableWorkerScan: true });
    assert.equal(store.sourceKind, 'step');
    assert.ok(store.entityIndex.byType.size > 0);

    // Expected from the type index, which for a STEP store is the source domain.
    const expected = new Set<number>();
    for (const [type, ids] of store.entityIndex.byType) {
      if (isPhysicalObjectType(type)) for (const id of ids) expected.add(id);
    }
    assert.ok(expected.size > 0);
    assert.deepEqual(sorted(collectEffectivePhysicalEntityIds(store, null)), sorted(expected));
  });
});
