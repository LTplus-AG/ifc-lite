/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validates the session's effective model (#5184, #5249): a deleted wall
 * is not validated, and a wall created this session is, under its class and
 * with its authored Name. Driven end to end through a real parsed store, a
 * real `MutablePropertyView` edited through `StoreEditor`, and the real
 * `validateIDS`. It covers both realms the viewer uses:
 *
 *   - main thread: `createDataAccessor(store, modelId, view)` (live view);
 *   - worker: the snapshot `useIDS` posts, rebuilt by
 *     `entityVisibilityFromSnapshot` after a structured clone, over a store
 *     re-parsed from the same bytes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type IDSModelInfo, type IFCDataAccessor } from '@ifc-lite/ids';
import { createDataAccessor as createBridgeAccessor } from '@ifc-lite/ids/bridge';

import { createDataAccessor } from './idsDataAccessor.js';
import {
  entityVisibilityFromSnapshot,
  snapshotEntityVisibility,
} from '@/lib/ids/property-overlay-snapshot';

const THREE_WALLS_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0Wall00000000000000001',$,'Wall_A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000002',$,'Wall_B',$,$,$,$,$,$);
#12=IFCDOOR('0Door00000000000000001',$,'Door_A',$,$,$,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

/** Every IfcWall must carry a Name matching `Wall_*`, at least three walls. */
const WALL_NAMES_IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Wall names</title></info>
  <specifications>
    <specification name="Walls are named Wall_*" ifcVersion="IFC4">
      <applicability minOccurs="3" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute>
          <name><simpleValue>Name</simpleValue></name>
          <value><xs:restriction base="xs:string"><xs:pattern value="Wall_.*"/></xs:restriction></value>
        </attribute>
      </requirements>
    </specification>
  </specifications>
</ids>
`;

async function parse(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(THREE_WALLS_IFC).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

const modelInfo: IDSModelInfo = { modelId: 'model-1', schemaVersion: 'IFC4', entityCount: 3 };

/** Delete Wall_B, create Wall_C (named) as a live session would. */
async function editedSession() {
  const store = await parse();
  const view = new MutablePropertyView(null, 'model-1');
  const editor = new StoreEditor(store, view);
  assert.equal(editor.removeEntity(11), true);
  const created = editor.addEntity('IfcWall', ['2Wall00000000000000003', null, 'Wall_C', null, null, null, null, null, null]);
  return { store, view, editor, createdId: created.expressId };
}

/** The ids the validator reports on, in validation order. */
async function validatedWalls(accessor: IFCDataAccessor): Promise<{ ids: number[]; applicable: number; status: string }> {
  const report = await validateIDS(parseIDS(WALL_NAMES_IDS), accessor, modelInfo);
  const spec = report.specificationResults[0];
  return {
    ids: spec.entityResults.map((r) => r.expressId).sort((a, b) => a - b),
    applicable: spec.applicableCount,
    status: spec.status,
  };
}

describe('IDS validates the effective model (#5184)', () => {
  it('control: the unedited store validates its two source walls and fails the minimum of three', async () => {
    const store = await parse();
    const result = await validatedWalls(createDataAccessor(store, 'model-1', new MutablePropertyView(null, 'model-1')));
    assert.deepEqual(result.ids, [10, 11]);
    assert.equal(result.status, 'fail');
  });

  it('main thread: the deleted wall is not validated, and the created wall is, with its authored Name', async () => {
    const { store, view, createdId } = await editedSession();
    const accessor = createDataAccessor(store, 'model-1', view);

    const result = await validatedWalls(accessor);
    assert.deepEqual(result.ids, [10, createdId]);
    assert.equal(accessor.getEntityType(createdId), 'IfcWall');
    assert.equal(accessor.getEntityName(createdId), 'Wall_C');
    assert.equal(accessor.getGlobalId(createdId), '2Wall00000000000000003');
    // Two applicable walls against minOccurs 3: the deleted wall is not counted.
    assert.equal(result.applicable, 2);
    assert.equal(result.status, 'fail');
  });

  it('main thread: a third created wall satisfies the cardinality the deleted one no longer can', async () => {
    const { store, view, editor, createdId } = await editedSession();
    const second = editor.addEntity('IfcWall', ['2Wall00000000000000004', null, 'Wall_D', null, null, null, null, null, null]).expressId;

    const result = await validatedWalls(createDataAccessor(store, 'model-1', view));
    assert.deepEqual(result.ids, [10, createdId, second]);
    assert.equal(result.status, 'pass');
  });

  it('a created wall retyped to a door leaves the wall specification, and a retyped door joins it', async () => {
    const { store, view, editor, createdId } = await editedSession();
    editor.setEntityType(createdId, 'IfcDoor');
    editor.setEntityType(12, 'IfcWall');

    const accessor = createDataAccessor(store, 'model-1', view);
    assert.deepEqual(accessor.getEntitiesByType('IfcWall').sort((a, b) => a - b), [10, 12]);
    assert.deepEqual(accessor.getEntitiesByType('IfcDoor'), [createdId]);
    assert.equal(accessor.getEntityType(12), 'IfcWall');
  });

  it('worker: the structured-cloned snapshot over a re-parsed store gives the same answer as the live view', async () => {
    const { store, view, createdId } = await editedSession();
    const workerStore = await parse();
    const snapshot = structuredClone(snapshotEntityVisibility(view));
    const workerAccessor = createBridgeAccessor(workerStore, undefined, entityVisibilityFromSnapshot(snapshot));

    const live = await validatedWalls(createDataAccessor(store, 'model-1', view));
    const worker = await validatedWalls(workerAccessor);
    assert.deepEqual(worker, live);
    assert.deepEqual(worker.ids, [10, createdId]);
    assert.deepEqual(workerAccessor.getAllEntityIds().sort((a, b) => a - b), [10, 12, createdId]);
  });

  it('a created-then-deleted wall is validated nowhere', async () => {
    const { store, view, editor, createdId } = await editedSession();
    editor.removeEntity(createdId);

    const result = await validatedWalls(createDataAccessor(store, 'model-1', view));
    assert.deepEqual(result.ids, [10]);
  });
});
