/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { importDxf } from '@ifc-lite/drawing-2d';
import { useDxfUnderlaysForDrawing, useDxfUnderlays3DLines } from './useDxfUnderlay';
import type { DxfUnderlayRenderData } from './dxfUnderlayMath';
import type { RendererLineVertices } from '@/lib/renderer/line-overlay-rte';

test('mounted DXF hooks render vertical references and keep 3D placement on registered plane (#6615)', async () => {
  const registration = await import('./dxfReferencePlane').catch((error: unknown) => {
    if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return null;
  });
  assert.ok(registration, 'DXF engineering-plane registration must be available');
  const { captureDxfReferenceFrame } = registration;
  const original=useViewerStore.getState(), container=document.createElement('div'),root=createRoot(container);
  const plane={axis:'z' as const,position:5,flipped:false};
  let drawing:readonly DxfUnderlayRenderData[]=[], lines:RendererLineVertices=new Float32Array();
  function Harness() {
    drawing=useDxfUnderlaysForDrawing({enabled:true,sectionAxis:'front',isCustomPlane:false,flipped:false,coordinateInfo:undefined,plane});
    lines=useDxfUnderlays3DLines(undefined); return null;
  }
  try {
    useViewerStore.setState({models:new Map(),geometryResult:null,ifcDataStore:null,dxfUnderlays:[]});
    const underlay=importDxf('0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nwall\n10\n0\n20\n0\n11\n4\n21\n3\n0\nENDSEC\n0\nEOF');
    const id=useViewerStore.getState().addDxfUnderlay(underlay,{referenceFrame:captureDxfReferenceFrame(useViewerStore.getState(),plane)});
    await act(async()=>root.render(<Harness/>));
    assert.deepEqual(drawing[0].lines[0].points,[{x:0,y:0},{x:4,y:3}]);
    const payload = ((): RendererLineVertices => lines)();
    assert.ok(!(payload instanceof Float32Array) && 'localVertices' in payload);
    if (!(payload instanceof Float32Array) && 'localVertices' in payload) {
      const numbers=Array.from(payload.localVertices),origin=payload.origin;
      assert.equal(numbers[2]+origin[2],5); assert.equal(numbers[5]+origin[2],5);
      assert.equal(numbers[3]-numbers[0],4); assert.equal(numbers[4]-numbers[1],3);
    }
    await act(async()=>useViewerStore.getState().setDxfUnderlayVisible(id,false));
    assert.equal(drawing.length,0);
    assert.ok(!(((): RendererLineVertices => lines)() instanceof Float32Array),'3D visibility remains independent');
  } finally { await act(async()=>root.unmount()); container.remove();useViewerStore.setState(original,true); }
});
