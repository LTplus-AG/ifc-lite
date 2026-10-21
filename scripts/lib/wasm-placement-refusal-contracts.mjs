/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { parseMeshesViaPrePass } from './mesh-via-prepass.mjs';

// #7877 / #7779: the native f3b_x1_placement_refusal solid and 2D-chain
// invariant, exercised through the real browser prepass + batch boundary.
const HEAD = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('7877 placement refusal contract'),'2;1');
FILE_NAME('placement.ifc','2026-10-21T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCCARTESIANPOINT((0.,0.));
#6=IFCAXIS2PLACEMENT2D(#5,$);
#16=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#17=IFCUNITASSIGNMENT((#16));
#19=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#4,$);
#20=IFCPROJECT('1Project00000000007779',$,'P',$,$,$,$,(#19),#17);
#30=IFCCARTESIANPOINT((0.,5.));
#31=IFCDIRECTION((0.,1.));
#32=IFCAXIS2PLACEMENT2D(#30,#31);
#33=IFCLOCALPLACEMENT($,#32);
`;

function wall(id, placement, frames, width) {
  return `${frames}
#${id + 1}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#6,${width}.,1.);
#${id + 2}=IFCEXTRUDEDAREASOLID(#${id + 1},#4,#2,1.);
#${id + 3}=IFCSHAPEREPRESENTATION(#19,'Body','SweptSolid',(#${id + 2}));
#${id + 4}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${id + 3}));
#${id}=IFCWALL('2Wall0000000000000${id}',$,'W${id}',$,$,${placement},#${id + 4},$,$);
`;
}

const NEIGHBOR = wall(200, '#209', `
#206=IFCCARTESIANPOINT((10.,0.,0.));
#208=IFCAXIS2PLACEMENT3D(#206,$,$);
#209=IFCLOCALPLACEMENT($,#208);`, 1);

function subject(placement, frames = '') {
  return wall(100, placement, frames, 2);
}

/** Copies from the canonical helper; it frees the real mesh/collection handles.
 * The outer finally also covers a prepass throw, before its own finally starts.
 * Each load owns its API so counters and caches cannot leak between controls.
 */
function load(IfcAPI, body, elementCount, meshCount) {
  const api = new IfcAPI();
  let collection;
  try {
    assert.equal(api.is_ready, true, 'a real initialized WASM API is required');
    assert.equal(api.getPipelineDiagnostics(), undefined, 'fresh load has no batch');
    collection = parseMeshesViaPrePass(api, `${HEAD}${body}ENDSEC;\nEND-ISO-10303-21;`);
    const diagnostics = api.getPipelineDiagnostics();
    assert.ok(diagnostics, 'normal batch must publish diagnostics');
    assert.equal(diagnostics.schemaVersion, 1);
    assert.equal(diagnostics.batches, 1);
    assert.equal(diagnostics.elementCount, elementCount, 'every product reached the producer');
    assert.equal(diagnostics.meshCount, meshCount);
    assert.equal(diagnostics.triangleCount, meshCount * 12, 'complete six-face solids');
    assert.equal(diagnostics.backstopCount, 0, 'no degenerate-triangle drops');
    assert.equal(diagnostics.totalCsgFailures, 0, 'no unrelated CSG failure');
    assert.equal(collection.length, meshCount);
    assert.equal(collection.totalTriangles, meshCount * 12);
    assert.equal(collection.hasRtcOffset(), false, 'small inline fixture needs no RTC shift');
    const meshes = new Map();
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      assert.ok(mesh);
      assert.ok(!meshes.has(mesh.expressId), 'one mesh per rectangular wall');
      assert.ok(mesh.positions instanceof Float32Array);
      assert.ok(mesh.indices instanceof Uint32Array);
      assert.ok(mesh.positions.length > 0);
      assert.equal(mesh.indices.length, 36);
      assert.ok(mesh.positions.every(Number.isFinite));
      assert.ok(mesh.indices.every(index => index < mesh.positions.length / 3));
      meshes.set(mesh.expressId, {
        positions: mesh.positions,
        normals: mesh.normals,
        indices: mesh.indices,
        origin: mesh.origin,
      });
    }
    return meshes;
  } finally {
    try {
      collection?.free();
    } finally {
      try {
        api.clearPrePassCache();
      } finally {
        api.free();
      }
    }
  }
}

function assertBounds(mesh, expected) {
  assert.ok(mesh, 'the selected product must have an actual mesh');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const index of mesh.indices) {
    for (let axis = 0; axis < 3; axis++) {
      const world = mesh.positions[index * 3 + axis] + (mesh.origin?.[axis] ?? 0);
      min[axis] = Math.min(min[axis], world);
      max[axis] = Math.max(max[axis], world);
    }
  }
  [...min, ...max].forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < 1e-6,
      `viewer bound ${index}: ${value}, expected ${expected[index]}`);
  });
}

export function runPlacementRefusalContracts(IfcAPI, test) {
  test('#7877/#7779: absent optional ObjectPlacement emits identity geometry', () => {
    const absent = load(IfcAPI, subject('$') + NEIGHBOR, 2, 2);
    const explicit = load(IfcAPI, subject('#109',
      '#109=IFCLOCALPLACEMENT($,#4);') + NEIGHBOR, 2, 2);
    assert.deepEqual([...absent.keys()].sort(), [100, 200]);
    assertBounds(absent.get(100), [-1, 0, -0.5, 1, 1, 0.5]);
    assert.deepEqual(absent, explicit, 'optional absence agrees with authored identity');
  });

  test('#7877/#7779: valid 2D placement chain translates and rotates real vertices', () => {
    const meshes = load(IfcAPI, subject('#109', `
#106=IFCCARTESIANPOINT((1.,0.,0.));
#108=IFCAXIS2PLACEMENT3D(#106,$,$);
#109=IFCLOCALPLACEMENT(#33,#108);`) + NEIGHBOR, 2, 2);
    // Native IFC bounds [-.5,5,0]..[.5,7,1]; WASM maps (x,y,z) to (x,z,-y).
    assertBounds(meshes.get(100), [-0.5, 0, -7, 0.5, 1, -5]);
    assertBounds(meshes.get(200), [9.5, 0, -0.5, 10.5, 1, 0.5]);
    const control = load(IfcAPI, NEIGHBOR, 1, 1);
    assert.deepEqual(meshes.get(200), control.get(200));
  });

  for (const [name, placement, frames] of [
    ['unreadable authored ObjectPlacement', '#999', ''],
    ['missing PlacementRelTo parent', '#109', '#109=IFCLOCALPLACEMENT(#999,#4);'],
    ['cyclic PlacementRelTo parents', '#109', `
#109=IFCLOCALPLACEMENT(#110,#4);
#110=IFCLOCALPLACEMENT(#109,#4);`],
    ['malformed relative-placement direction', '#109', `
#106=IFCCARTESIANPOINT((5.,0.,0.));
#107=IFCDIRECTION((1.));
#108=IFCAXIS2PLACEMENT3D(#106,#107,$);
#109=IFCLOCALPLACEMENT($,#108);`],
  ]) {
    test(`#7877/#7779: ${name} refuses geometry and preserves neighbor`, () => {
      const control = load(IfcAPI, NEIGHBOR, 1, 1);
      const meshes = load(IfcAPI, subject(placement, frames) + NEIGHBOR, 2, 1);
      assert.deepEqual([...meshes.keys()], [200], '#100 must not fabricate identity geometry');
      assertBounds(meshes.get(200), [9.5, 0, -0.5, 10.5, 1, 0.5]);
      assert.deepEqual(meshes.get(200), control.get(200), 'neighbor payload stays unchanged');
      // PipelineDiagnostics has no refusedInputElements field on this head.
      // elementCount=2, meshCount=1 proves submission vs output, not a typed
      // placement-refusal diagnostic; the native test separately checks that.
    });
  }
}
