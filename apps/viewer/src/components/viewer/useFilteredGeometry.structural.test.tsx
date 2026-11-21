/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useState } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StructuralViewMode } from '@/store/types';
import { TYPE_VISIBILITY_SEMANTIC_DEFAULTS } from '@/store/constants';
import { cleanup, render } from '@/test/render';
import { useFilteredGeometry } from './useFilteredGeometry';

afterEach(cleanup);
for (const spaces of [true,false]) {
  it(`#9923 #10264 every structural mode change hides by id over one upload (spaces=${spaces})`, () => {
    const mesh = (expressId:number,ifcType:string):MeshData => ({expressId,ifcType,
      positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array(9),
      indices:new Uint32Array([0,1,2]),color:[1,1,1,1]});
    const bounds = {min:{x:0,y:0,z:0},max:{x:1,y:1,z:1}};
    const geometry:GeometryResult = {meshes:[mesh(1,'IfcBeam'),mesh(2,'IfcStructuralCurveMember')],
      totalTriangles:2,totalVertices:6,coordinateInfo:{originShift:{x:0,y:0,z:0},
        originalBounds:bounds,shiftedBounds:bounds,hasLargeCoordinates:false}};
    const defaults = {...TYPE_VISIBILITY_SEMANTIC_DEFAULTS,spaces,spatialZones:true,
      openings:true,virtualElements:true,site:true,ifcAnnotations:true};
    let update!:(next:StructuralViewMode)=>void;
    let seen:number[] = [];
    const uploads = new Set<unknown>(); const versions = new Set<number>();
    function Probe() {
      const [mode,setMode] = useState<StructuralViewMode>('both');
      update = setMode;
      const scene = useFilteredGeometry(geometry,0,defaults,'model',mode);
      uploads.add(scene.sceneGeometry); versions.add(scene.geometryVersion);
      assert.deepEqual((scene.sceneGeometry ?? []).map(m=>m.expressId),[1,2],'the scene keeps every mesh');
      seen = (scene.sceneGeometry ?? []).map(m=>m.expressId).filter(id=>!scene.typeHidden.ids.has(id));
      return null;
    }
    render(<Probe />);
    assert.deepEqual(seen,[1,2]);
    for (const [mode,ids] of [['physical',[1]],['analytical',[2]],['both',[1,2]],['physical',[1]],['both',[1,2]]] as const) {
      act(()=>update(mode));
      assert.deepEqual(seen,[...ids],mode);
    }
    assert.equal(uploads.size,1,'one scene list across every mode');
    assert.equal(versions.size,1,'no mode change asks the streaming hook for an upload');
  });
}
