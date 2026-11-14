/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a loaded `.3dm` store says about itself, and what the gates that read
 * it then do (#9976, #9890). Driven by the real reader over a real `.3dm`, so
 * the store under test is the one a load builds, not a hand-stamped stub.
 *
 * The schema label names the classes the entity table holds, which for a
 * `.3dm` are IFC product classes: `IFC4`. What backs the store is the separate
 * marker `sourceKind: 'tabular'`. Labelling it `IFC5` made both answers one
 * answer and handed a `.3dm` IFCX behaviour it has no business with.
 *
 * Spec: docs/architecture/rhino-3dm-import.md.
 */

import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { countEffectiveEntityTypes, iterateEffectiveEntities } from '@ifc-lite/data';
import { createSyntheticDataStore, IfcParser, type IfcDataStore } from '@ifc-lite/parser';

import { canWriteIfcFromStores } from '@/components/viewer/export-model-selection';
import { exportModelStep } from '@/lib/export/model-step-export';
import { StepRecordsUnavailableError } from '@/lib/export/step-records';
import { buildShareSeed, isSeedableModel } from '@/lib/collab/share-scope';
import { isIfcxDataStore, type FederatedModel } from '@/store/types';
import { craftRhino3dm, rhinoPayloadOf } from '@/test/rhino-3dm-fixture.js';
import { fixtureModel } from '@/test/store-fixture.js';

/** The payload a `.3dm` load produces. */
const rhinoPayload = async () => rhinoPayloadOf(await craftRhino3dm());

/** A federation record around `store`, the fields `buildShareSeed` reads included. */
const modelRecord = (id: string, store: IfcDataStore): FederatedModel => ({
  ...fixtureModel(id), name: `${id}.3dm`, ifcDataStore: store, schemaVersion: store.schemaVersion,
} as unknown as FederatedModel);

/**
 * A model whose store states no marker, which is how every store built before
 * #9976 reads: `createSyntheticDataStore` sets none, and `data-store.ts` says
 * absent means "not tabular". The gates must keep carrying it.
 */
const unmarkedModel = (id: string) =>
  modelRecord(id, createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0 }));

/** A model backed by real STEP records, parsed from real STEP text. */
async function stepModel(id: string): Promise<FederatedModel> {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP_TEXT).buffer as ArrayBuffer);
  return modelRecord(id, store);
}

const STEP_TEXT = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('s.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('1hqIFTRjfV6AWq_bMtnZwI',$,$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

// The reader reports what it could not draw through console.warn.
beforeEach(() => mock.method(console, 'warn', () => undefined));
afterEach(() => mock.restoreAll());

describe('a loaded .3dm store, and the gates that read it', () => {
  it('is labelled IFC4 and marked tabular, and is not an IFCX store', async () => {
    const { dataStore, schemaVersion } = await rhinoPayload();

    assert.equal(schemaVersion, 'IFC4');
    assert.equal(dataStore.schemaVersion, 'IFC4');
    assert.equal(dataStore.sourceKind, 'tabular');
    // The bytes are a .3dm, so the STEP type index is empty and the entity
    // table is the only list of rows: exactly what the marker states.
    assert.equal(dataStore.entityIndex.byType.size, 0);
    assert.ok(dataStore.source.byteLength > 0);
    // Under the old IFC5 label this was true, and the model took the IFCX
    // exporter, the IFCX overlay re-composition and the IFCX room seed.
    assert.equal(isIfcxDataStore(dataStore), false);
  });

  it('enumerates its entities under the IFC4 label', async () => {
    const { dataStore } = await rhinoPayload();

    const rows = [...iterateEffectiveEntities(dataStore, null)];
    assert.deepEqual(rows.map((row) => row.expressId), [1, 2]);
    assert.deepEqual(rows.map((row) => row.type), ['IFCWALL', 'IFCBUILDINGELEMENTPROXY']);
    assert.deepEqual([...countEffectiveEntityTypes(dataStore, null)].sort(),
      [['IFCBUILDINGELEMENTPROXY', 1], ['IFCWALL', 1]]);
  });

  it('is refused by the STEP export paths, single and merged', async () => {
    const { dataStore } = await rhinoPayload();
    const rhino = modelRecord('rhino', dataStore), step = await stepModel('step');
    const alone = new Map([['rhino', rhino]]), both = new Map([['rhino', rhino], ['step', step]]);

    assert.equal(step.ifcDataStore?.sourceKind, 'step', 'the comparison store is really STEP-backed');
    // The single path is offered and refused by `exportModelStep` itself,
    // with the model named (#10099), so nothing downloads.
    assert.equal(canWriteIfcFromStores(alone, 'single', false), true);
    await assert.rejects(
      exportModelStep({ modelId: 'rhino', dataStore, options: { schema: 'IFC4', applyMutations: true }, scheduleState: null }),
      (error: unknown) => error instanceof StepRecordsUnavailableError && error.reason === 'noRecords',
    );
    // Nothing writable in the federation at all: the merged export refuses.
    assert.equal(canWriteIfcFromStores(alone, 'merged', false), false);
    // An IFCX target reads the tables, so it is allowed.
    assert.equal(canWriteIfcFromStores(alone, 'merged', true), true);
    // One tabular model beside a STEP one does not refuse the merge: it is
    // skipped, the way a model with no store is.
    assert.equal(canWriteIfcFromStores(both, 'merged', false), true);
    // A store from before the marker existed states none, and still exports.
    const unmarked = unmarkedModel('unmarked');
    assert.equal(unmarked.ifcDataStore?.sourceKind, undefined);
    assert.equal(canWriteIfcFromStores(new Map([['unmarked', unmarked]]), 'merged', false), true);
    await exportModelStep({ modelId: 'unmarked', dataStore: unmarked.ifcDataStore!, options: { schema: 'IFC4', applyMutations: true }, scheduleState: null });
  });

  it('is left out of a room seed, because neither seed path can carry it', async () => {
    const { dataStore } = await rhinoPayload();
    const models = new Map([['rhino', modelRecord('rhino', dataStore)], ['step', await stepModel('step')]]);

    // `seedFromStep` has no STEP records to read and `seedFromIfcx` would
    // re-parse .3dm bytes as IFCX, so the model is skipped rather than seeded
    // empty, which joiners would have received with no refusal.
    assert.deepEqual(buildShareSeed(models, 'rhino', 'all').models.map((m) => m.modelId), ['step']);
    assert.deepEqual(buildShareSeed(models, 'rhino', 'active').models, []);
    // The Share dialog counts seedable models with the same predicate, so its
    // "{seedable} of {loaded}" notice cannot promise a model the seed drops.
    assert.equal(isSeedableModel(models.get('rhino')!), false);
    assert.equal(isSeedableModel(models.get('step')!), true);
  });
});
