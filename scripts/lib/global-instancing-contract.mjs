/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The global instance plan at the real wasm boundary.
 *
 * The plan is opt-in (`setGlobalInstancePlan`, `addGlobalKeyPlan`,
 * `setGlobalKeyPlanning`). Pinned here:
 * - without it, the streaming pre-pass emits no plan events and no `planIndex`;
 * - with key planning, the pre-pass plans repeated content and ships each
 *   job's plan index with its chunk, and the columns carry model-wide mapped
 *   counts parallel to the mapped plan;
 * - with the plan installed, the partition instances planned geometry in ONE
 *   batch regardless of the per-batch gate, keeps class-toggled classes flat,
 *   appends the `IFNL` key trailer, and the decoder that predates the trailer
 *   reads the shard unchanged;
 * - geometry fingerprints and every instance's world box equal the unplanned
 *   batch's.
 */

import assert from 'node:assert/strict';
import { decodeInstancedShard } from '../../packages/geometry/dist/packed-instanced-decoder.js';

const WALLS = 10;
const SPACES = 8;
const CHAIRS = 9;
const KEY_TRAILER_MAGIC = 0x4946_4e4c;

function fixture() {
  const lines = [];
  let id = 1000;
  const owners = new Map();
  const placement = (x) => {
    const p = id++;
    const a = id++;
    const lp = id++;
    lines.push(`#${p}=IFCCARTESIANPOINT((${x}.,${x % 3}.,0.));`, `#${a}=IFCAXIS2PLACEMENT3D(#${p},#2,#3);`, `#${lp}=IFCLOCALPLACEMENT($,#${a});`);
    return lp;
  };
  const element = (cls, tail, shape, x) => {
    const lp = placement(x);
    const eid = id++;
    owners.set(eid, cls);
    lines.push(`#${eid}=${cls.toUpperCase()}('${String(eid).padStart(22, '0')}',$,'${cls}',$,$,#${lp},#${shape}${tail});`);
  };
  for (let i = 0; i < WALLS; i++) element('IfcWall', ',$,.NOTDEFINED.', 15, 2 * i);
  for (let i = 0; i < SPACES; i++) element('IfcSpace', ',$,.ELEMENT.,.SPACE.,$', 15, 2 * i + 1);
  for (let i = 0; i < CHAIRS; i++) {
    const mi = id++;
    const rep = id++;
    const pds = id++;
    lines.push(`#${mi}=IFCMAPPEDITEM(#21,#22);`, `#${rep}=IFCSHAPEREPRESENTATION(#6,'Body','MappedRepresentation',(#${mi}));`,
      `#${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
    element('IfcFurnishingElement', ',$', pds, 40 + 3 * i);
  }
  const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Global instance plan witness'),'2;1');
FILE_NAME('global-plan.ifc','2026-11-23T00:00:00',('Test'),('Test'),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.00001,#4,$);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCUNITASSIGNMENT((#7));
#9=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,(#6),#8);
#12=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#13=IFCTRIANGULATEDFACESET(#12,$,.T.,((1,3,2),(1,2,4),(1,4,3),(2,3,4)),$);
#14=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#23));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCCOLOURRGB($,0.5,0.5,0.5);
#17=IFCSURFACESTYLERENDERING(#16,$,$,$,$,$,$,$,.FLAT.);
#18=IFCSURFACESTYLE('Opaque',.BOTH.,(#17));
#19=IFCSTYLEDITEM(#13,(#18),$);
#20=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#13));
#21=IFCREPRESENTATIONMAP(#4,#20);
#22=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,$,$);
#23=IFCTRIANGULATEDFACESET(#12,$,.T.,((1,3,2),(1,2,4),(1,4,3),(2,3,4)),$);
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  return { bytes: new TextEncoder().encode(source), owners };
}

/** Streaming pre-pass events, with or without content-key planning. */
function stream(IfcAPI, bytes, planning) {
  const api = new IfcAPI();
  try {
    if (planning) api.setGlobalKeyPlanning(true);
    const events = [];
    api.buildPrePassStreaming(bytes, (event) => events.push(event), 4096);
    return events;
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}

/** Every mesh of a collection by element, with its world box (Y-up → IFC Z-up). */
function readCollection(collection) {
  const flat = new Map();
  try {
    const hashes = [...collection.geometryHashIds].map((eid, i) => `${eid}:${collection.geometryHashValues[i]}`).sort();
    for (let i = 0; i < collection.length; i++) {
      const mesh = collection.get(i);
      try {
        flat.set(mesh.expressId, { type: mesh.ifcType, box: box(mesh.positions, mesh.origin, true) });
      } finally {
        mesh.free();
      }
    }
    return { flat, hashes };
  } finally {
    collection.free();
  }
}

/** The flat batch over every job: the reference. */
function reference(IfcAPI, bytes) {
  const api = new IfcAPI();
  try {
    const pre = api.buildPrePassOnce(bytes);
    api.setComputeGeometryHashes(1e-3);
    return readCollection(api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
      pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors));
  } finally {
    api.clearPrePassCache();
    api.free();
  }
}

/** One partitioned batch over every job with the plan from `events` (content keys when `keyed`). */
function partition(IfcAPI, bytes, events, keyed) {
  const api = new IfcAPI();
  let result;
  try {
    const pre = api.buildPrePassOnce(bytes);
    api.setComputeGeometryHashes(1e-3);
    const columns = events.find((e) => e.type === 'prepass-columns');
    api.setGlobalInstancePlan(columns.mappedInstancePlan, columns.mappedInstanceCounts);
    if (keyed) {
      for (const e of events.filter((e) => e.type === 'jobs')) {
        api.addGlobalKeyPlan(e.jobs.filter((_, i) => i % 3 === 0), e.planIndex);
      }
    }
    result = api.processGeometryBatchPartitioned(bytes, pre.jobs, pre.unitScale, ...pre.rtcOffset,
      pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    return { ...readCollection(result.takeMeshes()), shard: result.takeShard() };
  } finally {
    result?.free();
    api.clearPrePassCache();
    api.free();
  }
}

/** World box of local positions + origin; flat meshes are Y-up, shard templates IFC Z-up. */
function box(positions, origin, yUp, m) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    let p = [origin[0] + positions[i], origin[1] + positions[i + 1], origin[2] + positions[i + 2]];
    if (m) p = [0, 1, 2].map((r) => m[4 * r] * p[0] + m[4 * r + 1] * p[1] + m[4 * r + 2] * p[2] + m[4 * r + 3]);
    if (yUp) p = [p[0], -p[2], p[1]];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  return [...lo, ...hi];
}

function trailerKeys(shard, templateCount) {
  const view = new DataView(shard.buffer, shard.byteOffset, shard.byteLength);
  const at = shard.byteLength - 8 - templateCount * 8;
  assert.equal(view.getUint32(at, true), KEY_TRAILER_MAGIC, 'the shard ends with the IFNL key trailer');
  assert.equal(view.getUint32(at + 4, true), templateCount);
  return Array.from({ length: templateCount }, (_, t) => view.getUint32(at + 8 + 8 * t, true));
}

export function runGlobalInstancingContract(IfcAPI, test) {
  console.log('\n📋 Global instance plan: opt-in pre-pass events, keyed shard, unchanged fingerprints');
  const { bytes, owners } = fixture();
  const ofClass = (cls) => [...owners].filter(([, c]) => c === cls).map(([eid]) => eid);

  test('without key planning the pre-pass emits no plan', () => {
    const events = stream(IfcAPI, bytes, false);
    assert.equal(events.some((e) => e.type === 'global-key-plan'), false);
    assert.equal(events.filter((e) => e.type === 'jobs').some((e) => 'planIndex' in e), false);
    const columns = events.find((e) => e.type === 'prepass-columns');
    assert.deepEqual(Array.from(columns.mappedInstancePlan), [21]);
    assert.deepEqual(Array.from(columns.mappedInstanceCounts), [CHAIRS], 'model-wide IfcMappedItem count per planned source');
  });

  test('key planning plans the repeated content and ships plan indices per job', () => {
    const events = stream(IfcAPI, bytes, true);
    const plan = events.find((e) => e.type === 'global-key-plan');
    assert.ok(plan && plan.keys >= 1, 'the shared face set is planned');
    const jobs = events.filter((e) => e.type === 'jobs');
    const planned = new Map();
    for (const e of jobs) {
      assert.equal(e.planIndex.length * 3, e.jobs.length, 'one plan index per job');
      e.planIndex.forEach((p, i) => planned.set(e.jobs[3 * i], p));
    }
    for (const eid of ofClass('IfcWall')) assert.equal(planned.get(eid), 0, `#${eid} wall is planned`);
    assert.equal(plan.plannedJobs, [...planned.values()].filter((p) => p !== 0xffffffff).length);
  });

  const checkPlanned = (planned, base, instancedIds, keyHas) => {
    assert.deepEqual(planned.hashes, base.hashes, 'every fingerprint is the flat batch\'s');
    assert.ok(planned.hashes.length >= WALLS + SPACES + CHAIRS);
    // The decoder that predates the trailer reads the keyed shard as IFNS.
    const shard = decodeInstancedShard(planned.shard);
    const instanced = shard.instances.map((i) => i.entityId).sort((a, b) => a - b);
    assert.deepEqual(instanced, instancedIds.sort((a, b) => a - b));
    for (const eid of ofClass('IfcSpace')) assert.equal(planned.flat.get(eid)?.type, 'IfcSpace', `#${eid} stays flat`);
    for (const [eid] of owners) {
      if (!instanced.includes(eid)) assert.ok(planned.flat.has(eid), `#${eid} is flat when not instanced`);
    }
    const keys = trailerKeys(planned.shard, shard.templates.length);
    assert.ok(keys.some(keyHas), `template keys ${keys}`);
    for (const inst of shard.instances) {
      const t = shard.templates[inst.templateIndex];
      assert.ok(t.indices.length > 0, 'every keyed record carries its geometry');
      const got = box(t.positions, t.origin, false, inst.transform);
      const want = base.flat.get(inst.entityId).box;
      got.forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-4, `#${inst.entityId} world box ${got} vs ${want}`));
    }
  };

  test('a mapped plan instances its source in one batch; unplanned repeats stay flat; fingerprints unchanged', () => {
    const base = reference(IfcAPI, bytes);
    const planned = partition(IfcAPI, bytes, stream(IfcAPI, bytes, false), false);
    checkPlanned(planned, base, ofClass('IfcFurnishingElement'), (hi) => hi === 21);
  });

  test('a content-key plan instances repeated direct geometry too, class-toggled classes excepted', () => {
    const base = reference(IfcAPI, bytes);
    const planned = partition(IfcAPI, bytes, stream(IfcAPI, bytes, true), true);
    checkPlanned(planned, base, [...ofClass('IfcWall'), ...ofClass('IfcFurnishingElement')], (hi) => hi >>> 31 === 1);
  });
}
