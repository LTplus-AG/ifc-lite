/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type IDSModelInfo } from '@ifc-lite/ids';

import { createDataAccessor } from './idsDataAccessor.js';

/** A wall (#1) with Pset_WallCommon.FireRating = "NONE". */
function makeStore(): IfcDataStore {
  const props = [
    {
      name: 'Pset_WallCommon',
      properties: [{ name: 'FireRating', value: 'NONE', type: 0, dataType: 'IFCLABEL' }],
    },
  ];

  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: () => 'IfcWall',
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId: new Map(), byType: new Map() },
    properties: { getForEntity: () => props },
    quantities: { getForEntity: () => [] },
  } as unknown as IfcDataStore;
}

describe('viewer createDataAccessor + MutablePropertyView overlay (#3929 re-validation)', () => {
  it('without a mutation view, reads the store value unchanged', () => {
    const accessor = createDataAccessor(makeStore(), 'model-1');
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'NONE',
    );
  });

  it('a correction applied through MutablePropertyView.setProperty is visible on re-validation', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'F90',
    );
  });

  it('a mutation on one entity does not leak into another entity\'s reads', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    // Entity #2 has no override registered and no base data (getForEntity
    // returns the same fixture for any id here) — the overlay resolver
    // must not apply entity #1's mutation to it: entity #2's read stays at
    // the base fixture value, not entity #1's corrected 'F90'.
    assert.strictEqual(
      accessor.getPropertyValue(2, 'Pset_WallCommon', 'FireRating')?.value,
      'NONE',
    );
  });

  it('an unrelated attribute/quantity mutation on the same entity does not affect a property read', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setAttribute(1, 'Name', 'Renamed Wall');

    const accessor = createDataAccessor(makeStore(), 'model-1', view);
    assert.strictEqual(
      accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
      'NONE',
    );
  });

  describe('undo staleness (#3943 — mutationHistory diverges from the live overlay after undo)', () => {
    it('after an undo, the accessor reads the reverted value, NOT the stale history entry', () => {
      const view = new MutablePropertyView(null, 'model-1');
      // The correction.
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
      // Undo: the viewer's mutationSlice re-applies the inverse with
      // skipHistory=true "to avoid polluting mutation history" — it does NOT
      // pop `mutationHistory`.
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'NONE', PropertyValueType.String, undefined, true);

      // Sanity: history still holds the stale, pre-undo 'F90' entry — this is
      // what made the old history-based resolver wrong.
      const history = view.getMutationsForEntity(1);
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].newValue, 'F90');

      const accessor = createDataAccessor(makeStore(), 'model-1', view);
      assert.strictEqual(
        accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
        'NONE',
        'accessor must read the live (reverted) value, not the stale history entry',
      );
    });

    it('redo after undo restores the correction', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'NONE', PropertyValueType.String, undefined, true); // undo
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String, undefined, true); // redo

      const accessor = createDataAccessor(makeStore(), 'model-1', view);
      assert.strictEqual(
        accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
        'F90',
      );
    });

    it('a correction with no undo still reads as corrected (does not over-correct the fix)', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

      const accessor = createDataAccessor(makeStore(), 'model-1', view);
      assert.strictEqual(
        accessor.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')?.value,
        'F90',
      );
    });

    it('undoing a brand-new property (never in base) removes the override entirely, falling back to base', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setProperty(1, 'Pset_WallCommon', 'NewProp', 'X', PropertyValueType.String);
      // Undo of a CREATE_PROPERTY calls deleteProperty (mutationSlice.ts),
      // which drops the key from the live overlay entirely rather than
      // leaving a DELETE marker (see MutablePropertyView.deleteProperty).
      view.deleteProperty(1, 'Pset_WallCommon', 'NewProp', true);

      const accessor = createDataAccessor(makeStore(), 'model-1', view);
      // The base store never had NewProp; the property must simply not be
      // reported as an override, not "deleted".
      assert.strictEqual(
        accessor.getPropertyValue(1, 'Pset_WallCommon', 'NewProp'),
        undefined,
      );
    });
  });
});

// ============================================================================
// End-to-end: the real `validateIDS()`, not just `accessor.getPropertyValue()`
// ============================================================================

/**
 * A real IfcWall (parsed by the real `IfcParser`, not a hand-built
 * `IfcDataStore` — the corrections re-validation path IS an `IfcDataStore`
 * consumer, so this is the same shape of store the app actually produces)
 * whose `Pset_WallCommon.FireRating` is `NONE`.
 */
const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('2nJrDaLQfJ1QPhdJR0o97J',$,'Wall 1',$,$,$,$,$,$);
#11=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);
#12=IFCPROPERTYSET('0pset0000000000000inst',$,'Pset_WallCommon',$,(#11));
#13=IFCRELDEFINESBYPROPERTIES('0rel00000000000000inst',$,$,$,(#10),#12);
ENDSEC;
END-ISO-10303-21;
`;

const FIRE_RATING_F90_IDS = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Walls must be rated F90</title></info>
  <specifications>
    <specification name="FireRating must be F90" ifcVersion="IFC4">
      <applicability maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLABEL">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><simpleValue>F90</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>
`;

async function parseWall(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(WALL_IFC).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

const modelInfo: IDSModelInfo = { modelId: 'model-1', schemaVersion: 'IFC4', entityCount: 1 };

describe('end-to-end: viewer createDataAccessor + real validateIDS() (#3943 coverage gap)', () => {
  it('the spec fails on the unmodified store, then passes once corrected through MutablePropertyView', async () => {
    const store = await parseWall();
    const doc = parseIDS(FIRE_RATING_F90_IDS);
    const view = new MutablePropertyView(null, 'model-1');

    const before = await validateIDS(doc, createDataAccessor(store, 'model-1', view), modelInfo);
    assert.strictEqual(before.specificationResults[0].status, 'fail');

    view.setProperty(10, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const after = await validateIDS(doc, createDataAccessor(store, 'model-1', view), modelInfo);
    assert.strictEqual(after.specificationResults[0].status, 'pass');
  });

  it('undoing the correction makes the real validateIDS() report fail again, not a stale pass', async () => {
    const store = await parseWall();
    const doc = parseIDS(FIRE_RATING_F90_IDS);
    const view = new MutablePropertyView(null, 'model-1');

    view.setProperty(10, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    const corrected = await validateIDS(doc, createDataAccessor(store, 'model-1', view), modelInfo);
    assert.strictEqual(corrected.specificationResults[0].status, 'pass');

    // Undo, exactly as `mutationSlice.ts` does it: re-apply the inverse with
    // skipHistory=true.
    view.setProperty(10, 'Pset_WallCommon', 'FireRating', 'NONE', PropertyValueType.String, undefined, true);

    const afterUndo = await validateIDS(doc, createDataAccessor(store, 'model-1', view), modelInfo);
    assert.strictEqual(
      afterUndo.specificationResults[0].status,
      'fail',
      'undo must not leave IDS reporting a stale PASS on data that reverted to failing',
    );
  });
});
