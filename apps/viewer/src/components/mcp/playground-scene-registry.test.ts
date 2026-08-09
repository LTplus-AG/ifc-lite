/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The playground registry's id lookups against multi-submesh elements (#2443),
 * the transparency state its operations re-derive (#2444), and the entity
 * counts they report back to the agent (#2452, #2455).
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
  countEntities,
  createEntityRegistry,
  selectTargets,
  type EntityRecord,
} from './playground-scene-registry.js';
import { createSectionState } from './playground-scene-view.js';
import { colorByProperty, colorize, hide, isolate, reset, show } from './playground-scene-ops.js';

const WALL_A_ID = 1;
const WALL_B_ID = 2;
const WALL_A_GUID = '2443SplitWallAAAAAAAAA';
const WALL_B_GUID = '2443SoloWallBBBBBBBBBB';

/** Two walls, so the model has an element with submeshes AND a control. */
async function twoWallModel(filename = 'split.ifc'): Promise<LoadedPlaygroundModel> {
  const bytes = new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#${WALL_A_ID}=IFCWALL('${WALL_A_GUID}',$,'Split Wall',$,$,$,$,$,.STANDARD.);`,
    `#${WALL_B_ID}=IFCWALL('${WALL_B_GUID}',$,'Solo Wall',$,$,$,$,$,.STANDARD.);`,
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n'));
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, filename);
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

describe('playground registry: the single-model precondition is enforced (#2471)', () => {
  /**
   * Everything the registry exposes is keyed model-unqualified — `byExpressId`,
   * `countEntities`, `colorByProperty`'s per-entity grouping, `byType`,
   * `byStorey`. That is sound for one STEP file, where `expressId` is unique,
   * and unsound the moment two models share the registry: `#1` would name two
   * different walls and every lookup would merge them.
   *
   * The `/mcp` playground cannot reach that state (single `model` state, no
   * `DispatchContext.registry`, `model_load` refuses, and `loadMeshes` clears
   * before it builds). These tests pin the last link so the assumption is
   * enforced rather than implicit — a future additive `loadMeshes` fails loudly
   * instead of silently merging two models' entities.
   *
   * The identity the guard tracks is the **model object**, not `model.id`:
   * `parsePlaygroundModel` slugs `id` out of the filename alone, so it is not
   * unique per load. The last two cases below are the ones an id comparison
   * waves straight through.
   */
  it('refuses to build a second model into a populated registry', async () => {
    const second = await twoWallModel('other.ifc');
    assert.notEqual(second.id, model.id, 'fixture check: the two models really are distinct');

    const { reg, modelGroup, section } = mount();
    assert.equal(reg.model, model, 'the registry names the model it holds');

    assert.throws(
      () => buildEntityRecords(reg, splitMeshes(), second, modelGroup, section),
      /#2471/,
      'a second model must not silently share the bare-expressId keyspace',
    );
  });

  it('refuses a re-upload of the SAME filename, which reuses the id', async () => {
    // The case an `id` comparison cannot see. Re-uploading a file (edited or
    // not) parses a second, independent model whose slug id is byte-identical
    // to the first — `playground-dispatcher`'s clash mesh cache keys on
    // `id:fileSize` precisely because of this. Its records must not merge into
    // the live registry's expressId buckets.
    const reupload = await twoWallModel();
    assert.equal(reupload.id, model.id, 'fixture check: the re-upload really does reuse the id');
    assert.notEqual(reupload, model, 'fixture check: but it is a distinct load');

    const { reg, modelGroup, section } = mount();
    assert.throws(
      () => buildEntityRecords(reg, splitMeshes(), reupload, modelGroup, section),
      /#2471/,
      'a same-filename re-upload is still a second model',
    );
  });

  it('refuses two filenames that slug to the SAME id', async () => {
    // `id` is `filename.replace(/\.ifc$/i,'').replace(/[^a-zA-Z0-9]+/g,'-').toLowerCase()`,
    // so genuinely different files collide: `A B.ifc` and `a-b.ifc` both become
    // `a-b`. Two real models, one id — the merge the precondition forbids.
    const spaced = await twoWallModel('A B.ifc');
    const hyphenated = await twoWallModel('a-b.ifc');
    assert.equal(spaced.id, hyphenated.id, 'fixture check: the two filenames really do collide');

    const reg = createEntityRegistry();
    const modelGroup = new THREE.Group();
    buildEntityRecords(reg, splitMeshes(), spaced, modelGroup, createSectionState());

    assert.throws(
      () => buildEntityRecords(reg, splitMeshes(), hyphenated, modelGroup, createSectionState()),
      /#2471/,
      'a slug collision must not be mistaken for the same model',
    );
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2, 'only the first model is indexed');
  });

  it('leaves the first model untouched when it refuses', async () => {
    // A guard that half-applied would be worse than none: the throw has to
    // happen before any indexing, or the registry ends up in exactly the merged
    // state the guard exists to prevent.
    const second = await twoWallModel('other.ifc');
    const { reg, modelGroup, section } = mount();
    const before = reg.records.length;

    assert.throws(() => buildEntityRecords(reg, splitMeshes(), second, modelGroup, section));

    assert.equal(reg.records.length, before, 'no record from the rejected model was indexed');
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2, 'and none merged into an existing bucket');
    assert.equal(countEntities(reg.records), 2, 'the entity count is still the first model alone');
    assert.equal(reg.model, model, 'the registry still names the model it actually holds');
  });

  it('accepts an additive build of the model it already holds', () => {
    // The guard rejects a second MODEL, not a second call. Re-entering with the
    // very same load is how a caller would append meshes, and it must stay
    // legal — otherwise the guard is a mutation nobody could distinguish from
    // "throw on every second call".
    const { reg, modelGroup, section } = mount();
    assert.doesNotThrow(() => buildEntityRecords(reg, splitMeshes(), model, modelGroup, section));
    assert.equal(reg.model, model);
  });

  it('does not claim the registry for a build that indexes nothing', async () => {
    // `EntityRegistry.model` documents `null` as "the registry is empty", and
    // the guard exists to stop two models sharing one bare-expressId keyspace.
    // A build that adds no records puts nothing in that keyspace, so claiming
    // the registry for it would state something untrue (an empty registry
    // naming a model it holds no record of) AND reject the next load for a
    // merge that cannot happen. A geometry-less model is a real load: an IFC
    // whose products all fail to tessellate reaches `loadMeshes` with `[]`.
    const reg = createEntityRegistry();
    const modelGroup = new THREE.Group();

    const counts = buildEntityRecords(reg, [], model, modelGroup, createSectionState());

    assert.deepEqual(counts, { opaqueCount: 0, transparentCount: 0 }, 'nothing was built');
    assert.equal(reg.records.length, 0, 'and nothing was indexed');
    assert.equal(reg.model, null, 'so the registry still belongs to no model');

    // The consequence that matters: the next load is not refused.
    const second = await twoWallModel('other.ifc');
    assert.doesNotThrow(
      () => buildEntityRecords(reg, splitMeshes(), second, modelGroup, createSectionState()),
      'an empty registry must accept any model - there is nothing to merge with',
    );
    assert.equal(reg.model, second, 'and it is claimed by the load that actually filled it');
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2, 'exactly that load, nothing merged');
  });

  it('releases the model identity on clear, so a model swap still works', async () => {
    // The one multi-model sequence the playground really performs: pick another
    // sample. `loadMeshes` clears, then builds — that must NOT trip the guard.
    const second = await twoWallModel('other.ifc');
    const { reg, modelGroup } = mount();

    clearEntityRecords(reg, modelGroup);
    assert.equal(reg.model, null, 'an empty registry belongs to no model');

    buildEntityRecords(reg, splitMeshes(), second, modelGroup, createSectionState());
    assert.equal(reg.model, second);
    assert.equal(reg.byExpressId.get(WALL_A_ID)?.length, 2, 'exactly the new load, not both');
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

  it('requests a shader rebuild when colorize() flips transparency, and not otherwise', () => {
    // The call-site half of #2454. `material-transparency.test.ts` proves at
    // the shader level that the rebuild is what makes the flip visible; what
    // is left to check here is that these two ops actually ask for it.
    // `version` is the observable — `needsUpdate` is write-only on a three
    // material, and it is the field `needsProgramChange` compares.
    const { reg } = mount();
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    const opaque = mat(target).version;

    colorize(reg, { expressIds: [WALL_B_ID], color: [1, 0, 0, 0.3] });
    assert.equal(mat(target).version, opaque + 1, 'opaque → translucent invalidates the program');

    colorize(reg, { expressIds: [WALL_B_ID], color: [0, 1, 0, 0.2] });
    assert.equal(mat(target).version, opaque + 1, 'a second translucent repaint changes no define');

    colorize(reg, { expressIds: [WALL_B_ID], color: [0, 0, 1, 1] });
    assert.equal(mat(target).version, opaque + 2, 'translucent → opaque invalidates it again');
  });

  it('requests a shader rebuild when reset() puts transparency back', () => {
    const { reg, section } = mount([tri(WALL_B_ID, 0, [0.5, 0.5, 0.5, 0.3])]);
    const target = (reg.byExpressId.get(WALL_B_ID) ?? [])[0];
    const m = mat(target);

    const translucent = m.version;
    reset(reg, section);
    assert.equal(m.version, translucent, 'a reset that changes nothing must not recompile');

    // Stale state, as a colorize-then-reset round trip leaves it.
    m.transparent = false;
    m.depthWrite = true;
    reset(reg, section);
    assert.equal(m.version, translucent + 1, 'restoring translucency has to reach the shader too');
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

describe('playground ops: the property legend counts entities (#2455)', () => {
  /** `viewer_color_by_property`'s sampler, plus the ids it was asked about. */
  function sampler(values: Record<number, string | null>) {
    const asked: number[] = [];
    return {
      asked,
      sample: (expressId: number) => { asked.push(expressId); return values[expressId] ?? null; },
    };
  }

  const args = { pset: 'Pset_WallCommon', property: 'IsExternal' };

  it('reports one element as one, however many submeshes it tessellates into', () => {
    // The fixture is the whole oracle: WALL_A is ONE wall that arrives as two
    // `MeshData` entries, so `byType` lists three records for two elements.
    // Bucketing those records answered the agent's histogram with 2 for a
    // bucket holding a single wall.
    const { reg } = mount();
    const { asked, sample } = sampler({ [WALL_A_ID]: 'true', [WALL_B_ID]: 'false' });

    const { legend } = colorByProperty(reg, { type: 'IfcWall', ...args, sample });

    assert.deepEqual(
      legend.map((l) => [l.value, l.count]),
      [['true', 1], ['false', 1]],
      'two walls, three submeshes, one entity per bucket',
    );
    // Sampling is per element too — the lookup used to repeat for every part.
    assert.deepEqual(asked.slice().sort((a, b) => a - b), [WALL_A_ID, WALL_B_ID]);
  });

  it('still recolours every submesh of a counted element', () => {
    // The other half of the contract, and the reason the fix cannot just be
    // `countEntities(records)`: acting per submesh, reporting per entity.
    const { reg } = mount();
    const { sample } = sampler({ [WALL_A_ID]: 'true', [WALL_B_ID]: 'false' });

    const { legend } = colorByProperty(reg, { type: 'IfcWall', ...args, sample });
    const [r, g, b] = legend[0].color;

    const parts = reg.byExpressId.get(WALL_A_ID) ?? [];
    assert.equal(parts.length, 2, 'fixture check: the wall really does have two submeshes');
    for (const part of parts) {
      assert.deepEqual([mat(part).color.r, mat(part).color.g, mat(part).color.b], [r, g, b],
        'a half-painted wall means the bucket dropped one of its parts');
      assert.deepEqual([part.baseColor.r, part.baseColor.g, part.baseColor.b], [r, g, b],
        'and the base colour has to follow, or reset() undoes half of it');
    }
  });

  it('counts an element once in the (missing) bucket too', () => {
    // The null path buckets by a literal key rather than by value, so it is
    // the one branch that could keep the old per-record count by accident.
    const { reg } = mount();
    const { asked, sample } = sampler({});

    const { legend } = colorByProperty(reg, { type: 'IfcWall', ...args, sample });

    assert.deepEqual(legend.map((l) => [l.value, l.count]), [['(missing)', 2]]);
    assert.equal(asked.length, 2, 'still one lookup per element');
  });

  it('reports nothing for a type the model does not have', () => {
    const { reg } = mount();
    const { asked, sample } = sampler({});
    assert.deepEqual(colorByProperty(reg, { type: 'IfcDoor', ...args, sample }).legend, []);
    assert.equal(asked.length, 0);
  });
});
