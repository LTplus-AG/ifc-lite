/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground registry's id lookups against multi-submesh elements (#2443),
 * and the transparency state its operations re-derive (#2444).
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
import { colorize, hide, isolate, reset, show } from './playground-scene-ops.js';

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
    // The contract in one line: act on every submesh, report in entities.
    assert.equal(res.count, 1, 'the agent asked for one element and is told one');

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
    assert.equal(res.count, 1, 'one element hidden, reported as one');
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
    assert.equal(res.count, 1, 'one element isolated, reported as one');
    for (const r of reg.byExpressId.get(WALL_A_ID) ?? []) {
      assert.equal(r.mesh.visible, true, 'isolating an element must not hide half of it');
    }
    assert.equal((reg.byExpressId.get(WALL_B_ID) ?? [])[0].mesh.visible, false);
  });

  it('reports entities, not submeshes, while still acting on every submesh', () => {
    // The mirror of the bug #2443 fixed. Making `selectTargets` return every
    // submesh silently changed what `{ count }` MEANS: a one-window colorize
    // started answering "2" whenever that window tessellated into glass +
    // frame. These tools are agent-facing and the dispatcher renders the
    // number as "Painted N entities", so the count has to be in entities or
    // the request and the response disagree — the same class of inconsistency
    // #2443 set out to remove, just moved into the reply.
    const { reg } = mount();

    // Both halves of the contract, asserted together: two materials change,
    // one entity is reported.
    const painted = colorize(reg, { expressIds: [WALL_A_ID], color: [1, 0, 0, 1] });
    const repainted = reg.records.filter(
      (r) => mat(r).color.r === 1 && mat(r).color.g === 0 && mat(r).color.b === 0,
    );
    assert.equal(repainted.length, 2, 'both submeshes were actually recoloured');
    assert.equal(painted.count, 1, 'and the agent is told one entity');

    // Multi-entity selection: 3 submeshes across 2 elements reports 2.
    assert.equal(
      colorize(reg, { expressIds: [WALL_A_ID, WALL_B_ID], color: [0, 1, 0, 1] }).count, 2,
      'two elements, three submeshes, reported as two',
    );
    assert.equal(hide(reg, { type: 'IfcWall' }).count, 2, 'type-addressing counts entities too');
    assert.equal(show(reg, { type: 'IfcWall' }).count, 2);
    assert.equal(isolate(reg, { type: 'IfcWall' }).count, 2);

    // And the unmatched case still reports nothing rather than throwing.
    assert.equal(hide(reg, { expressIds: [99999] }).count, 0);
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

describe('playground registry: colorize/reset keep depthWrite in sync (#2444)', () => {
  it('drops depthWrite when an opaque entity is colourised translucent', () => {
    const { reg } = mount();
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    assert.equal(mat(target).depthWrite, true, 'it loaded opaque');

    colorize(reg, { expressIds: [WALL_B_ID], color: [1, 0, 0, 0.3] });

    assert.equal(mat(target).transparent, true);
    assert.equal(mat(target).depthWrite, false, 'a translucent material must not write depth');
  });

  it('restores depthWrite when a translucent entity is colourised opaque', () => {
    const { reg } = mount([tri(WALL_B_ID, 0, [0.5, 0.5, 0.5, 0.3])]);
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    assert.equal(mat(target).depthWrite, false, 'it loaded translucent');

    colorize(reg, { expressIds: [WALL_B_ID], color: [1, 0, 0, 1] });

    assert.equal(mat(target).transparent, false);
    assert.equal(mat(target).depthWrite, true, 'an opaque material must write depth again');
  });

  it('re-derives the whole transparency triple on reset()', () => {
    // `viewer_reset` is the put-everything-back tool: whatever touched the
    // material in between, afterwards its rendering state must be exactly what
    // the record's base state implies. It restored `opacity` and `transparent`
    // only, so a material whose depthWrite disagreed with its own alpha stayed
    // that way (#2444).
    //
    // Driving it through colorize() would prove nothing here — colorize
    // overwrites `baseOpacity` too, so the two agree by construction and the
    // assertion holds with or without the fix. The stale state is set directly
    // instead, which is the invariant reset() actually owes its callers.
    const { reg, section } = mount([tri(WALL_B_ID, 0, [0.5, 0.5, 0.5, 0.3])]);
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    assert.equal(target.baseOpacity, 0.3, 'the base state of the record is translucent');

    const m = mat(target);
    m.transparent = false;
    m.opacity = 1;
    m.depthWrite = true;

    reset(reg, section);

    assert.equal(m.opacity, 0.3);
    assert.equal(m.transparent, true);
    assert.equal(m.depthWrite, false, 'depthWrite is part of what reset() restores');
  });

  it('agrees with construction on the transparency threshold', () => {
    // The constructor used `a < 1` while the operations used `a < 0.999`, so
    // an alpha in between mounted one way and reset() the other.
    const alpha = 0.9995;
    const { reg, section } = mount([tri(WALL_B_ID, 0, [1, 1, 1, alpha])]);
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    const mounted = { transparent: mat(target).transparent, depthWrite: mat(target).depthWrite };

    reset(reg, section);

    assert.deepEqual(
      { transparent: mat(target).transparent, depthWrite: mat(target).depthWrite },
      mounted,
      'a reset with no colorize in between must be a no-op on transparency state',
    );
  });
});
