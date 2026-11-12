/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// The member and reaction render probes (#9668) fail when the drawing is absent or misplaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { deriveCatalogue } from '../tests/structural-coverage/catalogue.mjs';
import { readStep } from '../tests/structural-coverage/lib/step.mjs';
import { lengthScale, meshDistance, topologyPoints } from '../tests/structural-coverage/lib/topology.mjs';
import render from '../tests/structural-coverage/probes/render.mjs';
import renderMembers from '../tests/structural-coverage/probes/render-members.mjs';

const root = resolve(import.meta.dirname, '..');
const { rows } = deriveCatalogue(root);
const row = (id) => rows.find((r) => r.id === id);
const ifc4 = (body) => readStep(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${body}ENDSEC;END-ISO-10303-21;`);

/** A corpus of one file, the way `loadCorpus` serves it to probes. */
function corpusOf(file) {
  return {
    files: [file],
    carriers: (schema, entity) => (file.schema === schema && file.step.count(entity) > 0 ? [file] : []),
    nothingCarries: () => ({ status: 'fail', reason: 'no corpus file carries it' }),
  };
}

async function score(probe, id, file, cache) {
  const r = row(id);
  return (await probe.run([r], { corpus: corpusOf(file), cache: new Map(cache) })).get(r.id);
}

/**
 * A member on an edge from (1, 2, 3) to (5, 2, 3) in file units: its placement
 * moves (0, 0, 0)-(4, 0, 0) by (1, 2, 3). `unit` is the project's length unit prefix.
 */
const MEMBER = (unit = '$') => `#1=IFCSIUNIT(*,.LENGTHUNIT.,${unit},.METRE.);#2=IFCUNITASSIGNMENT((#1));#3=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((4.,0.,0.));#12=IFCVERTEXPOINT(#10);#13=IFCVERTEXPOINT(#11);#14=IFCEDGE(#12,#13);
#15=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#14));#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#15));
#20=IFCCARTESIANPOINT((1.,2.,3.));#21=IFCAXIS2PLACEMENT3D(#20,$,$);#22=IFCLOCALPLACEMENT($,#21);
#30=IFCSTRUCTURALCURVEMEMBER('m',$,$,$,$,#22,#16,.RIGID_JOINED_MEMBER.,$);`;

/** A thin ribbon mesh from `a` to `b` (IFC world metres), in the render frame `origin + positions`, Y up. */
function ribbon(id, a, b, rtc = { x: 0, y: 0, z: 0 }) {
  const yUp = ([x, y, z]) => [x - rtc.x, z - rtc.z, -(y - rtc.y)];
  const [p, q] = [yUp(a), yUp(b)];
  const w = 0.1;
  const positions = [p[0], p[1], p[2] - w, p[0], p[1], p[2] + w, q[0], q[1], q[2] - w, q[0], q[1], q[2] + w];
  return { expressId: id, positions: new Float32Array(positions), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) };
}

const meshesOf = (meshes, frame = {}) => ({ byId: new Map(meshes.map((m) => [m.expressId, [m]])), frame });

test('#9668 topology oracle: placement and the project length unit, read from the file alone', () => {
  assert.deepEqual(topologyPoints(ifc4(MEMBER()), 30), [[1, 2, 3], [5, 2, 3]]);
  const mm = ifc4(MEMBER('.MILLI.'));
  assert.equal(lengthScale(mm), 1e-3);
  assert.deepEqual(topologyPoints(mm, 30).map((p) => p.map((c) => +c.toFixed(9))), [[0.001, 0.002, 0.003], [0.005, 0.002, 0.003]]);
});

test('#9668 member render: passes only for a mesh on the file\'s axis', async () => {
  const id = 'IFC4/IfcStructuralCurveMember';
  const file = { path: 'member.ifc', schema: 'IFC4', step: ifc4(MEMBER()) };
  const run = (drawn) => score(renderMembers, id, file, [['meshes:member.ifc', drawn]]);
  const good = await run(meshesOf([ribbon(30, [1, 2, 3], [5, 2, 3])]));
  assert.equal(good.status, 'pass', good.reason);
  // Drawn in an RTC-shifted render frame, as large models are.
  const rtc = { x: 1, y: 2, z: 3 };
  assert.equal((await run(meshesOf([ribbon(30, [1, 2, 3], [5, 2, 3], rtc)], { wasmRtcOffset: rtc }))).status, 'pass');
  // Not drawn, drawn at the unplaced origin, drawn half its length, or the RTC frame ignored.
  for (const drawn of [
    meshesOf([]),
    meshesOf([ribbon(30, [0, 0, 0], [4, 0, 0])]),
    meshesOf([ribbon(30, [1, 2, 3], [3, 2, 3])]),
    meshesOf([ribbon(30, [1, 2, 3], [5, 2, 3], rtc)]),
  ]) {
    const bad = await run(drawn);
    assert.equal(bad.status, 'fail', JSON.stringify(drawn.byId.get(30)?.[0]?.positions));
  }
  // A member the file states no topology for cannot pass, whatever is drawn.
  const bare = { path: 'bare.ifc', schema: 'IFC4', step: ifc4("#30=IFCSTRUCTURALCURVEMEMBER('m',$,$,$,$,$,$,.RIGID_JOINED_MEMBER.,$);") };
  const none = await score(renderMembers, id, bare, [['meshes:bare.ifc', meshesOf([ribbon(30, [0, 0, 0], [1, 0, 0])])]]);
  assert.equal(none.status, 'fail');
  assert.match(none.reason, /no topology representation/);
});

test('#9668 reaction render: a non-zero reaction must draw a glyph; a zero one is not checked', async () => {
  const id = 'IFC4/IfcStructuralPointReaction';
  const reaction = (fz) => ifc4(`#1=IFCSTRUCTURALLOADSINGLEFORCE($,0.,0.,${fz},0.,0.,0.);#2=IFCSTRUCTURALPOINTREACTION('r',$,$,$,$,$,$,#1,.GLOBAL_COORDS.);`);
  const file = { path: 'reaction.ifc', schema: 'IFC4', step: reaction('-5.') };
  const run = (f, drawn) => score(render, id, f, [[`render:${f.path}`, { drawn: new Set(drawn) }]]);
  assert.equal((await run(file, [2])).status, 'pass');
  const missed = await run(file, []);
  assert.equal(missed.status, 'fail');
  assert.match(missed.reason, /non-zero reaction draw no glyph/);
  const zero = await run({ ...file, path: 'zero.ifc', step: reaction('0.') }, []);
  assert.equal(zero.status, 'fail');
  assert.match(zero.reason, /unproven/);
});

test('#9937 review: advanced faces, degenerate triangles and lost geometry errors', async () => {
  const face = ifc4(`#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCCARTESIANPOINT((1.,0.,0.));#3=IFCCARTESIANPOINT((0.,1.,0.));
#4=IFCPOLYLOOP((#1,#2,#3));#5=IFCFACEOUTERBOUND(#4,.T.);#6=IFCAXIS2PLACEMENT3D(#1,$,$);#7=IFCPLANE(#6);
#8=IFCADVANCEDFACE((#5),#7,.T.);#9=IFCTOPOLOGYREPRESENTATION($,'Reference','Face',(#8));#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#9));
#11=IFCSTRUCTURALSURFACEMEMBER('s',$,$,$,$,$,#10,.SHELL.,0.2);`);
  assert.deepEqual(topologyPoints(face, 11), [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
  // A zero-area triangle next to a real one: the real one decides.
  const mesh = { positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 3, 4, 5]) };
  assert.equal(meshDistance([mesh], [0, 0, 0]), 0);
  // When no carrier meshes, the reason keeps the geometry error.
  const file = { path: 'member.ifc', schema: 'IFC4', step: ifc4(MEMBER()) };
  const failed = await score(renderMembers, 'IFC4/IfcStructuralCurveMember', file, [['meshes:member.ifc', { error: 'geometry threw: boom' }]]);
  assert.equal(failed.status, 'fail');
  assert.match(failed.reason, /geometry threw: boom/);
});
