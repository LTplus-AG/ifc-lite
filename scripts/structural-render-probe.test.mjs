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

/**
 * `MEMBER`, but its topology is an `IfcMappedItem` (as IfcOpenShell writes,
 * e.g. analysis-models cantilever_01): the map's edge (0, 0, 0)-(4, 0, 0)
 * sits at MappingOrigin (1, 0, 0); MappingTarget turns x onto y, scales by 2
 * and moves by (10, 0, 0); the placement then moves by (1, 2, 3). A body map
 * of the same edge is not topology.
 */
const MAPPED_MEMBER = `#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCUNITASSIGNMENT((#1));#3=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((4.,0.,0.));#12=IFCVERTEXPOINT(#10);#13=IFCVERTEXPOINT(#11);#14=IFCEDGE(#12,#13);
#15=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#14));
#40=IFCCARTESIANPOINT((1.,0.,0.));#41=IFCAXIS2PLACEMENT3D(#40,$,$);#42=IFCREPRESENTATIONMAP(#41,#15);
#43=IFCDIRECTION((0.,1.,0.));#44=IFCDIRECTION((0.,0.,1.));#45=IFCCARTESIANPOINT((10.,0.,0.));
#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#43,$,#45,2.,#44);#47=IFCMAPPEDITEM(#42,#46);
#48=IFCSHAPEREPRESENTATION($,'Reference','MappedRepresentation',(#47));
#50=IFCPOLYLINE((#10,#11));#51=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#50));#52=IFCREPRESENTATIONMAP(#41,#51);
#53=IFCMAPPEDITEM(#52,#46);#54=IFCSHAPEREPRESENTATION($,'Axis','MappedRepresentation',(#53));
#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#54,#48));
#20=IFCCARTESIANPOINT((1.,2.,3.));#21=IFCAXIS2PLACEMENT3D(#20,$,$);#22=IFCLOCALPLACEMENT($,#21);
#30=IFCSTRUCTURALCURVEMEMBER('m',$,$,$,$,#22,#16,.RIGID_JOINED_MEMBER.,$);`;

test('#9668 topology oracle: follows a mapped topology representation, origin then target', async () => {
  const step = ifc4(MAPPED_MEMBER);
  assert.deepEqual(topologyPoints(step, 30), [[11, 4, 3], [11, 12, 3]]);
  // A mapped shape representation that holds no topology gives no vertices.
  assert.deepEqual(topologyPoints(ifc4(MAPPED_MEMBER.replace('(#54,#48)', '(#54)')), 30), []);
  // The member is checked against the mapped axis: drawn there passes, drawn on the unmapped edge fails.
  const id = 'IFC4/IfcStructuralCurveMember';
  const file = { path: 'mapped.ifc', schema: 'IFC4', step };
  const run = (drawn) => score(renderMembers, id, file, [['meshes:mapped.ifc', drawn]]);
  const good = await run(meshesOf([ribbon(30, [11, 4, 3], [11, 12, 3])]));
  assert.equal(good.status, 'pass', good.reason);
  assert.equal((await run(meshesOf([ribbon(30, [1, 2, 3], [5, 2, 3])]))).status, 'fail');
});

test('#9668 topology oracle: a mapped topology it cannot follow leaves the member unplaced, not checked on fewer vertices', async () => {
  // The direct edge #15 stays beside the mapped one (drawn on [11, 4, 3]-[11, 12, 3]).
  const direct = MAPPED_MEMBER.replace('(#54,#48)', '(#54,#48,#15)');
  const cases = {
    unreadableOrigin: direct.replace('#42=IFCREPRESENTATIONMAP(#41,#15)', '#42=IFCREPRESENTATIONMAP(#99,#15)'),
    unreadableAxis: direct.replace('#43=IFCDIRECTION((0.,1.,0.))', '#43=IFCDIRECTION(($,$,$))'),
    pointAsAxis: direct.replace('#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#43,', '#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#45,'),
    emptyAxis: direct.replace('#43=IFCDIRECTION((0.,1.,0.))', '#43=IFCDIRECTION($)'),
    unreadableOriginAxis: direct.replace('#41=IFCAXIS2PLACEMENT3D(#40,$,$)', '#41=IFCAXIS2PLACEMENT3D(#40,#99,$)'),
    zeroOriginAxis: direct.replace('#41=IFCAXIS2PLACEMENT3D(#40,$,$)', '#41=IFCAXIS2PLACEMENT3D(#40,#59,$);#59=IFCDIRECTION((0.,0.,0.))'),
    zeroScale: direct.replace('$,#45,2.,#44', '$,#45,0.,#44'),
    // A map whose source representation maps itself, holding the topology edge too.
    cycle: direct.replace("#48=IFCSHAPEREPRESENTATION($,'Reference','MappedRepresentation',(#47))",
      "#48=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#47));#60=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#14,#62));#61=IFCREPRESENTATIONMAP(#41,#60);#62=IFCMAPPEDITEM(#61,#46)")
      .replace('#42=IFCREPRESENTATIONMAP(#41,#15)', '#42=IFCREPRESENTATIONMAP(#41,#60)'),
  };
  const id = 'IFC4/IfcStructuralCurveMember';
  const both = { byId: new Map([[30, [ribbon(30, [1, 2, 3], [5, 2, 3]), ribbon(30, [11, 4, 3], [11, 12, 3])]]]), frame: {} };
  for (const [name, body] of Object.entries(cases)) {
    const step = ifc4(body);
    assert.equal(topologyPoints(step, 30), null, name);
    const file = { path: `${name}.ifc`, schema: 'IFC4', step };
    // Refused whether the mesh covers only the direct edge or both.
    for (const drawn of [meshesOf([ribbon(30, [1, 2, 3], [5, 2, 3])]), both]) {
      const res = await score(renderMembers, id, file, [[`meshes:${name}.ifc`, drawn]]);
      assert.equal(res.status, 'fail', name);
      assert.match(res.reason, /cannot follow its placement or mapped topology/, name);
    }
  }
  // Followed: both edges, with nine nested maps or beside a mapped item whose map does not resolve.
  assert.equal(topologyPoints(ifc4(direct), 30).length, 4);
  let deep = direct;
  for (let i = 0; i < 9; i += 1) {
    const from = i === 0 ? '#15' : `#${70 + 2 * (i - 1) + 1}`;
    deep += `#${70 + 2 * i}=IFCREPRESENTATIONMAP(#41,${from});#${70 + 2 * i + 1}=IFCSHAPEREPRESENTATION($,'Reference','MappedRepresentation',(#${90 + i}));#${90 + i}=IFCMAPPEDITEM(#${70 + 2 * i},#46);`;
  }
  assert.equal(topologyPoints(ifc4(deep.replace('#47=IFCMAPPEDITEM(#42,#46)', '#47=IFCMAPPEDITEM(#86,#46)')), 30).length, 4);
  // Over 16 nested maps reaching topology: unplaced. Seventeen are refused, sixteen followed.
  let deeper = direct;
  for (let i = 0; i < 17; i += 1) {
    const from = i === 0 ? '#15' : `#${200 + 2 * (i - 1) + 1}`;
    deeper += `#${200 + 2 * i}=IFCREPRESENTATIONMAP(#41,${from});#${200 + 2 * i + 1}=IFCSHAPEREPRESENTATION($,'Reference','MappedRepresentation',(#${300 + i}));#${300 + i}=IFCMAPPEDITEM(#${200 + 2 * i},#46);`;
  }
  assert.equal(topologyPoints(ifc4(deeper.replace('#47=IFCMAPPEDITEM(#42,#46)', '#47=IFCMAPPEDITEM(#232,#46)')), 30), null);
  assert.equal(topologyPoints(ifc4(deeper.replace('#47=IFCMAPPEDITEM(#42,#46)', '#47=IFCMAPPEDITEM(#230,#46)')), 30).length, 4);
  // Shared maps multiplying past 10000 vertices: unplaced, quickly, not walked path by path.
  let shared = direct;
  for (let i = 0; i < 16; i += 1) {
    const from = i === 0 ? '#15' : `#${400 + 3 * (i - 1) + 2}`;
    shared += `#${400 + 3 * i}=IFCREPRESENTATIONMAP(#41,${from});#${400 + 3 * i + 1}=IFCMAPPEDITEM(#${400 + 3 * i},#46);#${400 + 3 * i + 2}=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#${400 + 3 * i + 1},#${400 + 3 * i + 1}));`;
  }
  const started = performance.now();
  assert.equal(topologyPoints(ifc4(shared.replace('#47=IFCMAPPEDITEM(#42,#46)', '#47=IFCMAPPEDITEM(#445,#46)')), 30), null);
  assert.ok(performance.now() - started < 2000, 'bounded walk');
  // The same fan-out over topology with no readable vertex: walked once per map, not per path.
  let empty = direct + "#59=IFCPOLYLINE((#10,#11));#56=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#59));";
  for (let i = 0; i < 16; i += 1) {
    const from = i === 0 ? '#56' : `#${500 + 5 * (i - 1) + 4}`;
    const m = 500 + 5 * i;
    empty += `#${m}=IFCREPRESENTATIONMAP(#41,${from});#${m + 1}=IFCMAPPEDITEM(#${m},#46);#${m + 2}=IFCMAPPEDITEM(#${m},#46);#${m + 3}=IFCMAPPEDITEM(#${m},#46);#${m + 4}=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(#${m + 1},#${m + 2},#${m + 3},#${m + 1}));`;
  }
  const emptyStarted = performance.now();
  assert.equal(topologyPoints(ifc4(empty.replace('#47=IFCMAPPEDITEM(#42,#46)', '#47=IFCMAPPEDITEM(#575,#46)')), 30).length, 2);
  assert.ok(performance.now() - emptyStarted < 2000, 'memoised walk');
  // The vertex cap counts direct vertices too, whatever the item order.
  const many = Array.from({ length: 5001 }, (_, i) => `#${1000 + i}=IFCEDGE(#12,#13);`).join('');
  const edges = Array.from({ length: 5001 }, (_, i) => `#${1000 + i}`).join(',');
  for (const order of [`#47,${edges}`, `${edges},#47`]) {
    const big = direct + many + `#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#600));#600=IFCTOPOLOGYREPRESENTATION($,'Reference','Edge',(${order}));`;
    assert.equal(topologyPoints(ifc4(big.replace('#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#54,#48,#15));', '')), 30), null, order.slice(0, 4));
  }
  // A map whose MappedRepresentation is not a representation holds nothing: the direct edge alone, no throw.
  assert.equal(topologyPoints(ifc4(direct.replace('#42=IFCREPRESENTATIONMAP(#41,#15)', '#42=IFCREPRESENTATIONMAP(#41,#46)')), 30).length, 2);
  const dangling = direct.replace('#53=IFCMAPPEDITEM(#52,#46)', '#53=IFCMAPPEDITEM(#98,#46)');
  assert.equal(topologyPoints(ifc4(dangling), 30).length, 4);
  // A cycle among maps that hold no topology (here the Axis map) does not hide the topology beside it.
  const axisCycle = direct.replace("#51=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#50))", "#51=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#50,#53))");
  assert.equal(topologyPoints(ifc4(axisCycle), 30).length, 4);
});

test('#9668 topology oracle: schema default axes (IfcFirstProjAxis, IfcSecondProjAxis)', () => {
  const near = (points) => points.map((p) => p.map((c) => +c.toFixed(9)));
  // A mirroring target with no Axis2 keeps y = (0, 1, 0): the origin's y of 2 stays +2 (z x x would flip it).
  const mirror = MAPPED_MEMBER.replace("#40=IFCCARTESIANPOINT((1.,0.,0.))", "#40=IFCCARTESIANPOINT((1.,2.,0.))")
    .replace("#43=IFCDIRECTION((0.,1.,0.))", "#43=IFCDIRECTION((-1.,0.,0.))").replace("$,#45,2.,#44", "$,#45,1.,#44");
  assert.deepEqual(near(topologyPoints(ifc4(mirror), 30)), [[10, 4, 3], [6, 4, 3]]);
  // A target whose Axis3 is -x and Axis1 omitted takes x = (0, 1, 0): (1, 0, 0) would leave nothing.
  const minusX = MAPPED_MEMBER.replace('#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#43,$,#45,2.,#44)', '#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#45,1.,#49);#49=IFCDIRECTION((-1.,0.,0.))');
  assert.deepEqual(near(topologyPoints(ifc4(minusX), 30)), [[11, 3, 3], [11, 7, 3]]);
  // 2D readers: an IfcAxis2Placement2D MappingOrigin, and a 2D target (Axis1 (0, 1, 0)) giving the same frame.
  const twoD = MAPPED_MEMBER.replace('#42=IFCREPRESENTATIONMAP(#41,#15)', '#42=IFCREPRESENTATIONMAP(#57,#15);#57=IFCAXIS2PLACEMENT2D(#40,$)')
    .replace('#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#43,$,#45,2.,#44)', '#46=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#43,$,#45,2.)');
  assert.deepEqual(near(topologyPoints(ifc4(twoD), 30)), [[11, 4, 3], [11, 12, 3]]);
  // A 2D target whose Axis2 points against x turned counter-clockwise mirrors y: origin (1, 2) lands at x 15, not 7.
  const twoDMirror = twoD.replace('#40=IFCCARTESIANPOINT((1.,0.,0.))', '#40=IFCCARTESIANPOINT((1.,2.,0.))')
    .replace('IFCCARTESIANTRANSFORMATIONOPERATOR2D(#43,$,#45,2.)', 'IFCCARTESIANTRANSFORMATIONOPERATOR2D(#43,#58,#45,2.);#58=IFCDIRECTION((1.,0.))');
  assert.deepEqual(near(topologyPoints(ifc4(twoDMirror), 30)), [[15, 4, 3], [15, 12, 3]]);
  // A RefDirection along Axis keeps R8's fallback, x = (0, 1, 0) x z.
  const parallel = ifc4(MEMBER().replace('#21=IFCAXIS2PLACEMENT3D(#20,$,$)', '#23=IFCDIRECTION((0.,0.,1.));#21=IFCAXIS2PLACEMENT3D(#20,#23,#23)'));
  assert.deepEqual(topologyPoints(parallel, 30), [[1, 2, 3], [5, 2, 3]]);
  // A placement z near (but not) x with no RefDirection takes x from (1, 0, 0).
  const tilted = ifc4(MEMBER().replace("#21=IFCAXIS2PLACEMENT3D(#20,$,$)", "#23=IFCDIRECTION((3.,0.,1.));#21=IFCAXIS2PLACEMENT3D(#20,#23,$)"));
  const r = Math.sqrt(10);
  assert.deepEqual(near(topologyPoints(tilted, 30)), near([[1, 2, 3], [1 + 4 / r, 2, 3 - 12 / r]]));
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
  // A zero-area triangle (two equal corners) measures 0/0 = NaN for a point on
  // its long side; the real triangle through the point must decide. The render
  // frame is Y up, so IFC (0, 0, 0.5) is render (0, 0.5, 0).
  const mesh = {
    positions: new Float32Array([0, 0, 0, 0, 0, 0, 0, 1, 0, -1, 0.5, -1, 1, 0.5, -1, 0, 0.5, 1]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
  assert.equal(meshDistance([mesh], [0, 0, 0.5]), 0);
  // When no carrier meshes, the reason keeps the geometry error.
  const file = { path: 'member.ifc', schema: 'IFC4', step: ifc4(MEMBER()) };
  const failed = await score(renderMembers, 'IFC4/IfcStructuralCurveMember', file, [['meshes:member.ifc', { error: 'geometry threw: boom' }]]);
  assert.equal(failed.status, 'fail');
  assert.match(failed.reason, /geometry threw: boom/);
});
