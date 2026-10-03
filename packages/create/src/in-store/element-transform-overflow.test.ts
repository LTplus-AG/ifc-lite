/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addWallToStore } from './wall.js';
import { addBeamToStore } from './beam.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { transformElementsInStore, type StoreyTransformOp } from './element-transform-edit.js';
import { toNativeLength, fromNativeLength } from './anchor.js';
import { resolvePlacementChain, translateProduct } from './edit/placement-core.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
for (const millimetres of [true, false]) for (const persisted of [false, true]) for(const operation of millimetres ? ['move','rotate','native-add'] as const : ['rotate'] as const) it(`#6232 ${operation} refuses overflowing derived placement on real Bonsai millimetres=${millimetres}, persisted=${persisted}`, async () => {
  let source = readFileSync(SAMPLE, 'utf8');
  if(millimetres) source=source.replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)');
  let dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  let view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(dataStore, view);
  const beam = addBeamToStore(editor, resolveSpatialAnchor(dataStore, 42, view), { Start:[1,2,3], End:[5,2,3], Width:.2, Height:.3 }).beamId;
  const wall=addWallToStore(editor,resolveSpatialAnchor(dataStore,42,view),{Start:[1,2,3],End:[5,2,3],Thickness:.2,Height:3}).wallId;
  const exported = () => new StepExporter(dataStore, view).export({ schema:'IFC4', applyMutations:true, timeStamp:'2026-10-03T00:00:00' }).content;
  if (persisted) {
    dataStore = await new IfcParser().parseColumnar(exported().slice().buffer as ArrayBuffer, { disableWorkerScan:true });
    view = new MutablePropertyView(null,'m'); editor = new StoreEditor(dataStore,view);
  }
  const snapshot = () => ({ graph:Array.from(exported()), records:structuredClone(view.getNewEntities()), journal:structuredClone(view.getMutations()), next:view.peekNextExpressId() });
  const before=snapshot();
  if(operation==='native-add') {
    // Finite native input can still overflow when added to a finite source leaf.
    editor.setPositionalAttribute(resolvePlacementChain(dataStore,view,editor,beam)!.cartesianPointId,0,[1e308,2000,3000]);
    const large=snapshot();
    expect(() => editor.runAtomic(draft => {
      const result=translateProduct(dataStore,draft.getMutationView(),draft,beam,[1e308,0,0]);
      if(!result.ok) throw new Error(result.reason);
    })).toThrow(/finite|overflow/i);
    expect(snapshot()).toEqual(large);
    let hookCalls=0;
    expect(() => editor.runAtomic(draft => transformElementsInStore({ dataStore, editor:draft, view:draft.getMutationView(), selected:[beam], op:{kind:'move',delta:[1e305,0]}, translate:()=>{hookCalls++;} }))).toThrow(/finite|overflow/i);
    expect(hookCalls).toBe(0);
    expect(snapshot()).toEqual(large);
  } else {
    const op: StoreyTransformOp=operation==='move'?{kind:'move',delta:[1e308,0]}:{kind:'rotate',pivot:[1e308,1e308],angle:Math.PI};
    expect(() => editor.runAtomic(draft => transformElementsInStore({ dataStore, editor:draft, view:draft.getMutationView(), selected:[operation==='rotate'?wall:beam], op }))).toThrow(/finite|overflow/i);
    expect(snapshot()).toEqual(before);
  }
  // A large representable conversion must not fail just because decimal
  // rounding multiplies it by 1e9; at this magnitude its ULP already exceeds 1nm.
  expect(toNativeLength({lengthUnitScale:.001},1e300)).toBe(1e303);
  expect(fromNativeLength({lengthUnitScale:.001},1e303)/1e300).toBeCloseTo(1,12);
});
