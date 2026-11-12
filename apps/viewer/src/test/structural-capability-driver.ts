/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '../test/setup-dom.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { federationRegistry } from '@ifc-lite/renderer';
import { LocalBackend } from '../sdk/local-backend.js';
import { StepExporter } from '@ifc-lite/export';
import { resolveExportVisibility } from '../store/exportVisibility.js';
import { fitAllBounds } from '../lib/visibility/visible-bounds.js';
import { structuralGlyphsVisible } from '../lib/visibility/structural-view.js';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
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
    federationRegistry.clear();
    // @raw-entity-enumeration-ok fixture scan establishes the real registry's ID range
    const maxExpressId = Math.max(...store.entityIndex.byId.keys());
    const models = Array.from({length:count}, (_,i)=> ({...fixtureModel(`m${i}`, {
      idOffset:federationRegistry.registerModel(`m${i}`,maxExpressId),
    }), ifcDataStore:store,maxExpressId}));
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
    // #9923: use the dialog's real visible-only resolver and exporter, then reparse.
    act(()=>setMode('physical'));
    const globalPhysical = useViewerStore.getState().toGlobalId(models[0].id,physical[0]);
    const globalAnalytical = useViewerStore.getState().toGlobalId(models[0].id,analytical[0]);
    const box = (x:number)=>({min:{x,y:0,z:0},max:{x:x+1,y:1,z:1}});
    assert.deepEqual(fitAllBounds({meshes:[{expressId:globalPhysical},{expressId:globalAnalytical}],
      instancedIds:[],instancedDrawn:true,typeOf:()=>undefined,
      boundsOf:(id)=>box(id===globalPhysical ? 0 : 1000),wholeScene:box(500),
      visibility:{hidden,isolated:null}}),box(0),'Fit All uses the same structural mask as the viewport');
    const filters = resolveExportVisibility(useViewerStore.getState(),models[0].id);
    assert.ok(analytical.every((id)=>filters.hiddenLocalIds.has(id)),JSON.stringify([...filters.hiddenLocalIds]));
    const {content} = new StepExporter(store).export({schema:'IFC2X3', visibleOnly:true,
      hiddenEntityIds:filters.hiddenLocalIds, isolatedEntityIds:filters.isolatedLocalIds ?? undefined});
    const output = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const reread = await new IfcParser().parseColumnar(output.buffer.slice(output.byteOffset,output.byteOffset+output.byteLength),{disableWorkerScan:true});
    assert.equal([...iterateEffectiveEntityIds(reread,null,['IfcStructuralCurveMember','IfcStructuralPointConnection'])].length,0);
    assert.equal([...iterateEffectiveEntityIds(reread,null,['IfcBeam','IfcColumn'])].length,physical.length);
    // #9923: model mode and the user's Supports & loads preference are independent.
    if (useViewerStore.getState().typeVisibility.structuralGlyphs) {
      act(()=>useViewerStore.getState().toggleTypeVisibility('structuralGlyphs'));
    }
    for (const mode of ['analytical','physical','both'] as const) {
      act(()=>setMode(mode));
      assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs,false, `${mode} preserves the manual glyph hide`);
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
  const backend = new LocalBackend(useViewerStore);
  let visibilityEvents = 0;
  const unsubscribe = backend.subscribe('visibility:changed',()=>{visibilityEvents++;});
  act(()=>setMode('physical'));
  unsubscribe();
  assert.equal(visibilityEvents,1,'SDK consumers are notified when the shared type visibility changes');
  // #9923: closing all models resets the transient mode, never the glyph preference.
  for (const preference of [true,false]) {
    if (useViewerStore.getState().typeVisibility.structuralGlyphs !== preference) {
      act(()=>useViewerStore.getState().toggleTypeVisibility('structuralGlyphs'));
    }
    act(()=>setMode('physical'));
    assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs,preference);
    assert.equal(structuralGlyphsVisible(useViewerStore.getState().typeVisibility,useViewerStore.getState().structuralViewMode),false);
    act(()=>useViewerStore.getState().clearAllModels());
    assert.equal(useViewerStore.getState().structuralViewMode,'both');
    assert.equal(structuralGlyphsVisible(useViewerStore.getState().typeVisibility,useViewerStore.getState().structuralViewMode),preference);
  }
  console.log('CAP_TOGGLE=' + JSON.stringify({status:'pass',counts,evidence:[path]}));
}
