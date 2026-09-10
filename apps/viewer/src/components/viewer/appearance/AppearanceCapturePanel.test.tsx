/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { AppearanceCapturePanel } from './AppearanceCapturePanel';
import type { MeshData } from '@ifc-lite/geometry';
afterEach(cleanup);
test('removing the pinned captured surface never silently substitutes another loaded object (#4380)', () => {
  const mesh: MeshData = {expressId:1,positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array(9),indices:new Uint32Array([0,1,2]),uvs:new Float32Array([0,0,1,0,0,1]),color:[1,1,1,1],textureRef:{textureId:1,url:'missing.png',repeatS:false,repeatT:false}};
  const bounds={min:{x:0,y:0,z:0},max:{x:1,y:1,z:0}};
  const geometry={meshes:[mesh],totalTriangles:1,totalVertices:3,coordinateInfo:{originShift:{x:0,y:0,z:0},originalBounds:bounds,shiftedBounds:bounds,hasLargeCoordinates:false}};
  const first={...fixtureModel('first'),geometryResult:geometry},other={...fixtureModel('other'),geometryResult:{...geometry,meshes:[{...mesh,expressId:2}]}};
  useViewerStore.setState({models:new Map([['first',first],['other',other]]),selectedEntityId:1,activeModelId:'first',modelPlacement:emptyPlacementState(),collabRoomId:null,mutationViews:new Map()});
  const ui=render(<AppearanceCapturePanel/>),select=ui.querySelector<HTMLSelectElement>('select[aria-label="Captured source surface"]')!;
  assert.equal(select.value,'first:0');
  act(()=>useViewerStore.setState({models:new Map([['other',other]])}));
  assert.equal(select.value,'');assert.equal(select.selectedOptions[0].textContent,'Choose a source surface');
  act(()=>{select.value='other:0';select.dispatchEvent(new window.Event('change',{bubbles:true}));});
  assert.equal(select.value,'other:0','another source requires an explicit choice');
});
