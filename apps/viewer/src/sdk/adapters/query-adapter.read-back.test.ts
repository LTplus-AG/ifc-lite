/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.mutate.setProperty()` followed by `bim.properties()` / `bim.property()`
 * in the viewer must return the edit, not the parsed value — the CLI fixed
 * this in `query-overlay.ts`; the viewer adapter read `EntityNode` directly
 * until #5167's flow graph tabulated nulls for what it had just written.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { configureMutationView } from '@/utils/configureMutationView';
import { createMutateAdapter } from './mutate-adapter.js';
import { createQueryAdapter } from './query-adapter.js';

const MODEL_ID = 'read-back-model';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('rb.ifc','2024-01-01T00:00:00',(''),(''),'','','');
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
#60=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#61=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_WallCommon',$,(#60));
#62=IFCRELDEFINESBYPROPERTIES('0rdbp00000000000000000',$,$,$,(#50),#61);
#70=IFCRELAGGREGATES('0kTvXnbbzCWw8lcMd1dR4o',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cont00000000000000000',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
`;

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(FIXTURE);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = { ...fixtureModel(MODEL_ID), ifcDataStore: dataStore } as unknown as FederatedModel;
  // Wired like the real viewer does it: the overlay needs the on-demand base
  // extractors to answer for unmutated entities.
  const view = new MutablePropertyView(dataStore.properties || null, MODEL_ID);
  configureMutationView(view, dataStore);
  useViewerStore.setState({
    ...fixtureModels(model),
    mutationViews: new Map([[MODEL_ID, view]]),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationVersion: 0,
  });
}

const ref = { modelId: MODEL_ID, expressId: 50 };

describe('viewer bim.properties() reads back pending mutations', () => {
  beforeEach(seed);

  it('a set property, a changed property and a deleted property are all visible to the next read', () => {
    const bim = createBimContext({ backend: { mutate: createMutateAdapter(useViewerStore), query: createQueryAdapter(useViewerStore) } as never });
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'IsExternal'), true, 'parsed value before any edit');
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'FireRating'), null);

    bim.mutate.setProperty(ref, 'Pset_WallCommon', 'FireRating', 'REI60');
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'FireRating'), 'REI60', 'the write is readable in the same session');
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'IsExternal'), true, 'untouched siblings survive the merge');

    bim.mutate.setProperty(ref, 'Pset_WallCommon', 'IsExternal', false);
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'IsExternal'), false);

    bim.mutate.deleteProperty(ref, 'Pset_WallCommon', 'FireRating');
    assert.equal(bim.property(ref, 'Pset_WallCommon', 'FireRating'), null);
    assert.deepEqual(bim.properties(ref).map((p) => p.name), ['Pset_WallCommon']);
  });
});
