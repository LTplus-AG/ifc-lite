/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '../test/setup-dom.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '../store/index.js';
import { useVisibilityState } from '../hooks/useViewerSelectors.js';
import { fixtureModel, fixtureModels } from '../test/store-fixture.js';
import { render, cleanup } from '../test/render.js';

const path = 'tests/models/structural/ifc_structuralanalysisview/roof_truss--Axis-Struc.ifc';
const bytes = readFileSync(path);
const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
// Expected ids come from the harness's independent STEP reader, not the product parser.
const expected: unknown = JSON.parse(process.argv[2] ?? '{}');
assert.ok(typeof expected === 'object' && expected !== null && 'physical' in expected && 'analytical' in expected);
assert.ok(Array.isArray(expected.physical) && expected.physical.every(Number.isSafeInteger));
assert.ok(Array.isArray(expected.analytical) && expected.analytical.every(Number.isSafeInteger));
const physical: number[] = expected.physical;
const analytical: number[] = expected.analytical;
const products = [...physical,...analytical].sort((a,b)=>a-b);
physical.sort((a,b)=>a-b);
analytical.sort((a,b)=>a-b);
assert.ok(physical.length && analytical.length, 'fixture has both product sets');
const state = useViewerStore.getState();
if (!('setStructuralViewMode' in state) || typeof state.setStructuralViewMode !== 'function') {
  console.log('CAP_TOGGLE=' + JSON.stringify({ status: 'fail', reason: 'viewer has no analytical/physical visibility action' }));
} else {
  const setMode = state.setStructuralViewMode;
  const counts = [];
  for (const count of [1, 2]) {
    const models = Array.from({length:count}, (_,i)=> ({...fixtureModel(`m${i}`, { idOffset: count === 1 ? 0 : (i+1)*1_000_000 }), ifcDataStore:store}));
    useViewerStore.setState({...fixtureModels(...models), ifcDataStore:store, hiddenEntities:new Set(), isolatedEntities:null});
    let hidden = new Set<number>();
    function Probe() { hidden = useVisibilityState().hiddenEntities; return null; }
    render(createElement(Probe));
    for (const [mode, expected] of [['physical',physical],['analytical',analytical],['both',products],['physical',physical]] as const) {
      act(()=>setMode(mode));
      for (const model of models) {
        const gid = (id:number)=>useViewerStore.getState().toGlobalId(model.id,id);
        assert.deepEqual(products.filter((id)=>!hidden.has(gid(id))), [...expected], `${count} models, ${mode}`);
      }
      counts.push({models:count,mode,visible:expected.length});
    }
    // Mode changes must compose with user hides and model visibility.
    const target = models[0];
    const id = useViewerStore.getState().toGlobalId(target.id,physical[0]);
    act(()=>useViewerStore.getState().hideEntity(id));
    act(()=>setMode('both'));
    assert.ok(hidden.has(id));
    act(()=>useViewerStore.getState().setModelVisibility(target.id,false));
    assert.ok(products.every((p)=>hidden.has(useViewerStore.getState().toGlobalId(target.id,p))));
    cleanup();
  }
  console.log('CAP_TOGGLE=' + JSON.stringify({status:'pass',counts,evidence:[path]}));
}
