/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import type { SectionPlaneConfig } from './types.js';

async function projectionClipper() {
  // Keep all test cases registered when the revert oracle removes this new
  // module. Missing bounded projection is an assertion, not a load failure.
  const module = await import('./projection-clip.js').catch(() => null);
  assert.ok(module, 'bounded projection clipping must be available');
  return module.clipMeshToProjectionWindow;
}

const wedge = (origin?: [number, number, number]): MeshData => ({
  expressId: 6615, ifcType: 'IfcWall', modelIndex: 0, origin,
  positions: new Float32Array([0, 0, 0, 10, 0, -10, 0, 2, -10]),
  normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
});
const plane: SectionPlaneConfig = { axis: 'z', position: 0, flipped: false };

/** Winding-independent footprint oracle: a box projects to its XY rectangle. */
function box(min: [number,number,number], max: [number,number,number], modelIndex=0): MeshData {
  const [a,b,c] = min, [x,y,z] = max;
  return { expressId:6615,ifcType:'IfcWall',modelIndex,color:[1,1,1,1],
    positions:new Float32Array([a,b,c,x,b,c,x,y,c,a,y,c,a,b,z,x,b,z,x,y,z,a,y,z]),
    normals:new Float32Array(24),
    indices:new Uint32Array([0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,3,2,6,3,6,7,0,3,7,0,7,4,1,5,6,1,6,2]),
  };
}

describe('exact projection depth (#6615)', () => {
  it('clips a crossing triangle whose original far vertices are both outside the band', async () => {
    const clipMeshToProjectionWindow = await projectionClipper();
    const mesh = wedge();
    const clipped = clipMeshToProjectionWindow(mesh, plane, 1, 3)!;
    expect(clipped).not.toBeNull();
    for (let i = 2; i < clipped.positions.length; i += 3) {
      expect(-clipped.positions[i]).toBeGreaterThanOrEqual(1);
      expect(-clipped.positions[i]).toBeLessThanOrEqual(3);
    }
    expect(Math.max(...clipped.positions.filter((_, i) => i % 3 === 0))).toBeCloseTo(3);
    expect(mesh.positions[3]).toBe(10); // original engineering geometry is untouched
  });

  it('preserves local origins and reverses the physical retained side on Flip', async () => {
    const clipMeshToProjectionWindow = await projectionClipper();
    const mesh = wedge([100, 200, 300]);
    const clipped = clipMeshToProjectionWindow(mesh, { ...plane, position: 300 }, 1, 3)!;
    expect(clipped.origin).toEqual(mesh.origin);
    expect(clipped.positions[2]).toBeLessThanOrEqual(-1);
    expect(clipMeshToProjectionWindow(mesh, { ...plane, position: 300, flipped: true }, 1, 3)).toBeNull();
    expect(clipMeshToProjectionWindow(mesh, plane, 0, 0)).toBeNull();
  });

  const wasmPath = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  async function planDrawing(meshes:MeshData[],includeHiddenLines=true,belowDepth=3) {
    const wasm = await import('../../wasm/pkg/ifc-lite.js');
    wasm.initSync({module:readFileSync(wasmPath)});
    const generator = new Drawing2DGenerator();
    try {
      return await generator.generate(meshes,{
        plane:{axis:'y',position:2,flipped:false},projectionDepth:belowDepth,projectionBelowDepth:belowDepth,projectionAboveDepth:3,
        clipProjectionBands:true,includeHiddenLines,creaseAngle:30,scale:100,
      },{useGPU:false,includeHiddenLines,includeProjection:true,includeEdges:true,mergeLines:false,
        outlineProvider(mesh,axis,flipped) {
          const handle=wasm.meshOutline2d(mesh.positions,mesh.indices,axis==='y'?1:axis==='z'?2:0,flipped);
          if (!handle) return null;
          try {
            const contours:Float32Array[]=[];
            for (let i=0;i<handle.contourCount;i++) {
              const ring=handle.contour(i); if(ring) contours.push(ring);
            }
            return {contours,axisMin:handle.axisMin,axisMax:handle.axisMax};
          } finally {handle.free();}
        },
      });
    } finally {generator.dispose();}
  }

  it.skipIf(!existsSync(wasmPath))('does not double-draw a cut-spanning plan wall as solid and dashed (#6615)',async()=>{
    const drawing=await planDrawing([box([0,0,0],[4,4,4])]);
    const projected=drawing.lines.filter(line=>line.category==='projection');
    expect(projected.filter(line=>line.visibility==='visible')).toHaveLength(4);
    expect(projected.filter(line=>line.visibility==='hidden')).toHaveLength(0);
  });

  it.skipIf(!existsSync(wasmPath))('excludes occluded far outlines but preserves dashed overhead when the bounded SDK caller disables HLR output (#6615)',async()=>{
    const scene=[{...box([-4,0,-4],[4,1,4]),expressId:66156},
      {...box([-1,-3,-1],[1,-2,1]),expressId:66157},
      {...box([5,3,5],[7,4,7]),expressId:66158}]; // distinct overhead band
    const all=await planDrawing(scene,true,7);
    const visible=await planDrawing(scene,false,7);
    const far=all.lines.filter(line=>line.category==='projection' && line.entityId===66157);
    expect(far.length).toBeGreaterThan(0);
    expect(far.every(line=>line.visibility==='hidden')).toBe(true);
    expect(visible.lines.some(line=>line.entityId===66157)).toBe(false);
    expect(visible.lines.some(line=>line.entityId===66156 && line.visibility==='visible')).toBe(true);
    const overhead=visible.lines.filter(line=>line.category==='projection' && line.entityId===66158);
    expect(overhead).toHaveLength(4); // a real overhead rectangle survives the SDK flag
    expect(overhead.every(line=>line.visibility==='hidden')).toBe(true);
    expect(visible.lines.filter(line=>line.visibility==='hidden').every(line=>line.entityId===66158)).toBe(true);
  });

  it.skipIf(!existsSync(wasmPath))('preserves distinct overhang contours and only trims their covered portions (#6615)',async()=>{
    // Same IFC entity, two body meshes: narrow wall plus wider overhead cap.
    const drawing=await planDrawing([box([0,0,0],[2,4,2]),box([0,3,0],[4,4,2])]);
    const hidden=drawing.lines.filter(line=>line.category==='projection' && line.visibility==='hidden');
    expect(hidden.length).toBeGreaterThan(0);
    const points=hidden.flatMap(line=>[line.line.start,line.line.end]);
    expect(Math.max(...points.map(p=>p.x))).toBeCloseTo(4); // real 2m overhang survives
    expect(hidden.every(line=>line.line.start.x>=2-1e-6 && line.line.end.x>=2-1e-6)).toBe(true);
  });

  it.skipIf(!existsSync(wasmPath))('does not remove a coincident overhead footprint from another federated model (#6615)',async()=>{
    const drawing=await planDrawing([box([0,0,0],[4,4,4],0),box([0,3,0],[4,4,4],1)]);
    expect(drawing.lines.filter(line=>line.category==='projection' && line.modelIndex===1 && line.visibility==='hidden')).toHaveLength(4);
  });

  it.skipIf(!existsSync(wasmPath))('runs the real WASM footprint extractor AFTER clipping, not on the full wedge', async () => {
    const wasm = await import('../../wasm/pkg/ifc-lite.js');
    wasm.initSync({ module: readFileSync(wasmPath) });
    const generator = new Drawing2DGenerator();
    try {
      const drawing = await generator.generate([wedge()], {
        plane, projectionDepth: 3, projectionBelowDepth: 3, projectionAboveDepth: 0,
        clipProjectionBands: true, includeHiddenLines: false, creaseAngle: 30, scale: 100,
      }, {
        useGPU: false, includeHiddenLines: false, includeProjection: true, includeEdges: true,
        mergeLines: false,
        outlineProvider(mesh, axis, flipped) {
          const handle = wasm.meshOutline2d(mesh.positions, mesh.indices, axis === 'z' ? 2 : axis === 'y' ? 1 : 0, flipped);
          if (!handle) return null;
          try {
            const contours: Float32Array[] = [];
            for (let i = 0; i < handle.contourCount; i++) {
              const contour = handle.contour(i);
              if (contour) contours.push(contour);
            }
            return { contours, axisMin: handle.axisMin, axisMax: handle.axisMax };
          } finally { handle.free(); }
        },
      });
      const projected = drawing.lines.filter(line => line.category === 'projection');
      expect(projected.length).toBeGreaterThan(0);
      const xs = projected.flatMap(line => [line.line.start.x, line.line.end.x]);
      expect(Math.max(...xs)).toBeCloseTo(3);
      expect(Math.min(...xs)).toBeCloseTo(0);
    } finally { generator.dispose(); }
  });
});
