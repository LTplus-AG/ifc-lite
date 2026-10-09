/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS-031: outline rows and the tree keyboard model (WAI-ARIA tree pattern). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commit } from '@ifc-lite/ids-authoring';
import { wallFixture } from '@/test/ids-studio-fixture';
import { addSpecOps } from './ops';
import { outlineKey, outlineRows, sectionRowId } from './outline';

describe('Studio outline (IDS-031)', () => {
  it('flattens specs, sections and facets in document order, honouring collapsed rows and the filter', async () => {
    const { state, specId, entityId, propertyId } = await wallFixture();
    const doors = addSpecOps({ name: 'Doors – acoustic', ifcVersions: ['IFC4'] });
    const doc = commit(state, doors.ops).state.doc;
    assert.deepEqual(outlineRows(doc, new Set()).map((r) => r.id), [
      specId, sectionRowId(specId, 'applicability'), entityId, sectionRowId(specId, 'requirements'), propertyId,
      doors.specId, sectionRowId(doors.specId, 'applicability'), sectionRowId(doors.specId, 'requirements'),
    ]);
    assert.deepEqual(outlineRows(doc, new Set([specId])).map((r) => r.id).slice(0, 2), [specId, doors.specId]);
    assert.deepEqual(outlineRows(doc, new Set([sectionRowId(specId, 'applicability')])).map((r) => r.id).slice(0, 3),
      [specId, sectionRowId(specId, 'applicability'), sectionRowId(specId, 'requirements')]);
    assert.deepEqual(outlineRows(doc, new Set(), 'ACOUSTIC').map((r) => r.id)[0], doors.specId);
    const empty = outlineRows(doc, new Set()).find((r) => r.id === sectionRowId(doors.specId, 'requirements'));
    assert.equal(empty?.expandable, false, 'an empty section has nothing to expand');
  });

  it('moves, expands, collapses and climbs to the parent like a tree', async () => {
    const { doc, specId, entityId } = await wallFixture();
    const rows = outlineRows(doc, new Set());
    const section = sectionRowId(specId, 'applicability');
    assert.deepEqual(outlineKey(rows, null, 'ArrowDown', new Set()), { kind: 'focus', id: specId });
    assert.deepEqual(outlineKey(rows, specId, 'ArrowRight', new Set()), { kind: 'focus', id: section }, 'open: go to the first child');
    assert.deepEqual(outlineKey(rows, specId, 'ArrowLeft', new Set()), { kind: 'collapse', id: specId });
    assert.deepEqual(outlineKey(rows, entityId, 'ArrowLeft', new Set()), { kind: 'focus', id: section }, 'a leaf climbs to its parent');
    assert.deepEqual(outlineKey(outlineRows(doc, new Set([specId])), specId, 'ArrowRight', new Set([specId])), { kind: 'expand', id: specId });
    assert.deepEqual(outlineKey(rows, entityId, 'End', new Set()), { kind: 'focus', id: rows[rows.length - 1].id });
    assert.deepEqual(outlineKey(rows, entityId, 'x', new Set()), { kind: 'none' });
  });
});
