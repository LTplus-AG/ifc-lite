/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.mutate.batch()` through the viewer adapter: every mutation the
 * batch encloses is tagged as one undo batch, so one undo reverts them all
 * and one redo restores them all. Before this, `batchBegin` was a TODO and
 * a graph run of N property writes needed N undos.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { createMutateAdapter } from './mutate-adapter.js';

const MODEL_ID = 'batch-model';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('batch.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#41,$,$,.ELEMENT.,0.);
#41=IFCLOCALPLACEMENT($,#21);
#50=IFCWALL('1wall00000000000000000',$,'W1',$,$,#41,$,$,.SOLIDWALL.);
#51=IFCWALL('2wall00000000000000000',$,'W2',$,$,#41,$,$,.SOLIDWALL.);
#52=IFCWALL('3wall00000000000000000',$,'W3',$,$,#41,$,$,.SOLIDWALL.);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50,#51,#52),#40);
ENDSEC;
END-ISO-10303-21;
`;

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore } as unknown as FederatedModel;
  useViewerStore.setState({
    ...fixtureModels(model),
    mutationViews: new Map([[MODEL_ID, new MutablePropertyView(dataStore.properties || null, MODEL_ID)]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationVersion: 0,
  });
}

const walls = [50, 51, 52];
const ref = (expressId: number) => ({ modelId: MODEL_ID, expressId });
const rating = (expressId: number) => useViewerStore.getState().getMutationView(MODEL_ID)?.getPropertyValue(expressId, 'Pset_WallCommon', 'FireRating') ?? null;

describe('bim.mutate.batch through the viewer mutate adapter', () => {
  beforeEach(seed);

  it('one undo reverts every write the batch enclosed, one redo restores them', () => {
    const mutate = createMutateAdapter(useViewerStore);
    const bim = createBimContext({ backend: { mutate } as never });

    bim.mutate.batch('flow run', () => {
      for (const id of walls) bim.mutate.setProperty(ref(id), 'Pset_WallCommon', 'FireRating', 'REI60');
    });
    assert.deepEqual(walls.map(rating), ['REI60', 'REI60', 'REI60']);
    const stack = useViewerStore.getState().undoStacks.get(MODEL_ID) ?? [];
    assert.equal(stack.length, 3);
    const tags = new Set(stack.map((m) => useViewerStore.getState().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'every enclosed mutation carries the same batch id');
    assert.ok(!tags.has(undefined));

    assert.equal(bim.mutate.undo(MODEL_ID), true);
    assert.deepEqual(walls.map(rating), [null, null, null], 'a single undo reverted the whole batch');
    assert.equal((useViewerStore.getState().undoStacks.get(MODEL_ID) ?? []).length, 0);

    assert.equal(bim.mutate.redo(MODEL_ID), true);
    assert.deepEqual(walls.map(rating), ['REI60', 'REI60', 'REI60'], 'a single redo restored the whole batch');
  });

  it('writes outside a batch stay individual undo steps, and nested batches fold into the outer one', () => {
    const mutate = createMutateAdapter(useViewerStore);
    const bim = createBimContext({ backend: { mutate } as never });

    bim.mutate.setProperty(ref(50), 'Pset_WallCommon', 'FireRating', 'before');
    bim.mutate.batch('outer', () => {
      bim.mutate.setProperty(ref(51), 'Pset_WallCommon', 'FireRating', 'outer');
      bim.mutate.batch('inner', () => {
        bim.mutate.setProperty(ref(52), 'Pset_WallCommon', 'FireRating', 'inner');
      });
    });
    const state = useViewerStore.getState();
    const stack = state.undoStacks.get(MODEL_ID) ?? [];
    assert.equal(stack.length, 3);
    assert.equal(state.mutationBatchTags.get(stack[0].id), undefined, 'the write before the batch is untagged');
    assert.equal(state.mutationBatchTags.get(stack[1].id), state.mutationBatchTags.get(stack[2].id), 'inner folds into outer');

    bim.mutate.undo(MODEL_ID);
    assert.deepEqual(walls.map(rating), ['before', null, null]);
    bim.mutate.undo(MODEL_ID);
    assert.deepEqual(walls.map(rating), [null, null, null]);
  });

  it('a mismatched batchEnd is refused and leaves the batch open', () => {
    const mutate = createMutateAdapter(useViewerStore);
    mutate.batchBegin('a');
    assert.throws(() => mutate.batchEnd('b'), /does not match the open batch "a"/);
    mutate.batchEnd('a');
  });
});
