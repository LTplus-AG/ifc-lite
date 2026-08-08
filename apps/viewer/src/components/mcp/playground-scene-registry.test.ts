/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground registry's id lookups against multi-submesh elements (#2443).
 *
 * Why this is reachable from CI when the scene is not: only `createScene`
 * needs a GPU (`new THREE.WebGLRenderer` throws under happy-dom, which is why
 * `PlaygroundViewer.test.ts` refuses to mount the component). Everything under
 * test here — `buildEntityRecords`, `selectTargets`, and the colour/visibility
 * operations — are plain functions over an `EntityRegistry`, and the three.js
 * objects they build (`BufferGeometry`, `MeshStandardMaterial`, `Group`)
 * construct, mutate and dispose entirely on the CPU. So the defect is testable
 * even though the factory that wires it up is not.
 *
 * The fixture is the oracle, and it is the whole point: WALL_A tessellates
 * into TWO `MeshData` entries — the per-material / per-CSG-part split that
 * `packages/geometry/src/types.ts` documents as normal — and WALL_B into one.
 * A fixture with one submesh per element could not express the broken state
 * (last-wins and accumulate are indistinguishable at N=1), so it would prove
 * nothing.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { MeshData } from '@ifc-lite/geometry';
import { parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';
import {
  buildEntityRecords,
  clearEntityRecords,
  createEntityRegistry,
  selectTargets,
  type EntityRecord,
} from './playground-scene-registry.js';
import { createSectionState } from './playground-scene-view.js';
import { colorize, hide, isolate, show } from './playground-scene-ops.js';

const WALL_A_ID = 1;
const WALL_B_ID = 2;
const WALL_A_GUID = '2443SplitWallAAAAAAAAA';
const WALL_B_GUID = '2443SoloWallBBBBBBBBBB';

/** Two walls, so the model has an element with submeshes AND a control. */
async function twoWallModel(): Promise<LoadedPlaygroundModel> {
  const bytes = new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#${WALL_A_ID}=IFCWALL('${WALL_A_GUID}',$,'Split Wall',$,$,$,$,$,.STANDARD.);`,
    `#${WALL_B_ID}=IFCWALL('${WALL_B_GUID}',$,'Solo Wall',$,$,$,$,$,.STANDARD.);`,
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n'));
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'split.ifc');
}

/** One triangle, offset so each submesh is a distinct object. */
function tri(expressId: number, offset: number, color: [number, number, number, number]): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color,
  };
}

/**
 * WALL_A as a glass + frame pair, WALL_B as a single solid. The two WALL_A
 * submeshes carry different colours precisely so a fix that indexes only one
 * of them cannot hide behind identical materials.
 */
function splitMeshes(): MeshData[] {
  return [
    tri(WALL_A_ID, 0, [1, 1, 1, 1]),   // frame, opaque
    tri(WALL_A_ID, 2, [0, 0.4, 1, 1]), // glass, opaque (alpha varied per-test)
    tri(WALL_B_ID, 4, [0.5, 0.5, 0.5, 1]),
  ];
}

function mat(r: EntityRecord): THREE.MeshStandardMaterial {
  return r.mesh.material as THREE.MeshStandardMaterial;
}

let model: LoadedPlaygroundModel;
before(async () => { model = await twoWallModel(); });

/** A fresh registry + model group holding the three submeshes above. */
function mount(meshes: MeshData[] = splitMeshes()) {
  const reg = createEntityRegistry();
  const modelGroup = new THREE.Group();
  const section = createSectionState();
  const tally = buildEntityRecords(reg, meshes, model, modelGroup, section);
  return { reg, modelGroup, section, tally };
}

describe('playground registry: id lookups cover every submesh (#2443)', () => {
  it('resolves the fixture metadata the rest of the suite stands on', () => {
    // Guards the fixture itself: if GlobalId enrichment ever stopped
    // resolving, every globalId assertion below would pass vacuously by
    // selecting nothing.
    const { reg } = mount();
    assert.equal(reg.records.length, 3, 'three submeshes across two elements');
    assert.deepEqual(
      reg.records.map((r) => r.globalId),
      [WALL_A_GUID, WALL_A_GUID, WALL_B_GUID],
      'each record carries the GlobalId of the element it belongs to',
    );
  });

  it('indexes both submeshes of one element under its expressId', () => {
    const { reg } = mount();
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2);
    assert.equal(reg.byExpressId.get(WALL_B_ID)?.length, 1);
  });

  it('selects both submeshes by expressId', () => {
    const { reg } = mount();
    assert.equal(selectTargets(reg, { expressIds: [WALL_A_ID] }).length, 2);
  });

  it('selects both submeshes by GlobalId', () => {
    const { reg } = mount();
    assert.equal(selectTargets(reg, { globalIds: [WALL_A_GUID] }).length, 2);
  });

  it('makes id-addressing and type-addressing agree on the same element', () => {
    // The headline symptom: `viewer_isolate({ type })` reached every submesh
    // while `viewer_colorize({ expressIds })` reached one, so the same element
    // answered differently depending on how the agent named it.
    const { reg } = mount();
    const byType = selectTargets(reg, { type: 'IfcWall' })
      .filter((r) => r.expressId === WALL_A_ID);
    const byId = selectTargets(reg, { expressIds: [WALL_A_ID] });
    const byGuid = selectTargets(reg, { globalIds: [WALL_A_GUID] });
    assert.equal(byType.length, 2, 'type-addressing already reached both');
    assert.deepEqual(new Set(byId), new Set(byType));
    assert.deepEqual(new Set(byGuid), new Set(byType));
  });

  it('colorizes every submesh of an element addressed by expressId', () => {
    const { reg } = mount();
    const res = colorize(reg, { expressIds: [WALL_A_ID], color: [1, 0, 0, 1] });
    assert.equal(res.count, 2, 'the tool reports both submeshes');

    for (const r of reg.byExpressId.get(WALL_A_ID) ?? []) {
      assert.deepEqual(
        [mat(r).color.r, mat(r).color.g, mat(r).color.b], [1, 0, 0],
        'no submesh of the addressed element keeps its old colour',
      );
    }
    const other = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    assert.notDeepEqual([mat(other).color.r, mat(other).color.g, mat(other).color.b], [1, 0, 0]);
  });

  it('hides every submesh of an element addressed by GlobalId', () => {
    const { reg } = mount();
    const res = hide(reg, { globalIds: [WALL_A_GUID] });
    assert.equal(res.count, 2);
    for (const r of reg.byExpressId.get(WALL_A_ID) ?? []) {
      assert.equal(r.mesh.visible, false, 'a partial ghost means one submesh was missed');
    }
    assert.equal((reg.byExpressId.get(WALL_B_ID) ?? [])[0].mesh.visible, true);

    show(reg, { globalIds: [WALL_A_GUID] });
    for (const r of reg.byExpressId.get(WALL_A_ID) ?? []) {
      assert.equal(r.mesh.visible, true, 'and show() must bring all of them back');
    }
  });

  it('isolates every submesh of an element addressed by expressId', () => {
    const { reg } = mount();
    const res = isolate(reg, { expressIds: [WALL_A_ID] });
    assert.equal(res.count, 2);
    for (const r of reg.byExpressId.get(WALL_A_ID) ?? []) {
      assert.equal(r.mesh.visible, true, 'isolating an element must not hide half of it');
    }
    assert.equal((reg.byExpressId.get(WALL_B_ID) ?? [])[0].mesh.visible, false);
  });

  it('disposes every submesh, not just the last one indexed', () => {
    const { reg, modelGroup } = mount();
    const disposed = new Set<string>();
    reg.records.forEach((r, i) => {
      r.mesh.geometry.addEventListener('dispose', () => disposed.add(`geom${i}`));
      mat(r).addEventListener('dispose', () => disposed.add(`mat${i}`));
    });

    clearEntityRecords(reg, modelGroup);

    assert.deepEqual(
      [...disposed].sort(),
      ['geom0', 'geom1', 'geom2', 'mat0', 'mat1', 'mat2'],
      'every GPU resource of every submesh is released',
    );
    assert.equal(modelGroup.children.length, 0);
    assert.equal(reg.records.length, 0);
    assert.equal(reg.byExpressId.size, 0);
    assert.equal(reg.byGlobalId.size, 0);
  });

  it('re-indexes cleanly across a model swap', () => {
    // clearEntityRecords empties the lists rather than orphaning them; a
    // second load must not accumulate on top of the first.
    const { reg, modelGroup } = mount();
    clearEntityRecords(reg, modelGroup);
    buildEntityRecords(reg, splitMeshes(), model, modelGroup, createSectionState());
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2, 'exactly the new load, not both');
    assert.equal(selectTargets(reg, { expressIds: [WALL_A_ID] }).length, 2);
  });
});
