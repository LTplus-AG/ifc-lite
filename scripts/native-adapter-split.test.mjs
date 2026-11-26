/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collect, pack, unpack, verdict } from './native-adapter-split.mjs';
import { jobLaneSteps, judge, LANES, SPLIT_JUDGE, SPLIT_LANE_JOBS } from './lib/native-adapter-split.mjs';
import { compareLayouts, m11nInvariants, markers, sameReference, timingFreeHash } from './lib/native-adapter-split-compare.mjs';

const REPO = join(import.meta.dirname, '..');

function scratch(context) {
  const dir = mkdtempSync(join(tmpdir(), 'na-split-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

/** A fake native job's output: $RUNNER_TEMP references, native-compare, and m7 in the crate. */
function nativeOutputs(base) {
  const temp = join(base, 'temp');
  const root = join(base, 'root');
  put(join(temp, 'm3-native-openings.json'), '{"a":1}');
  put(join(temp, 'native-references/m5-native-clips.json'), '[1]');
  put(join(temp, 'native-compare/products.tsv'), 'model\tid\tms\n1\t2\t3\n');
  put(join(temp, 'retained-native-link-inventory.json'), '{}'); // not a reference
  put(join(root, 'rust/wasm-bindings/m7-native-reference.output.json'), '[7]');
  return { temp, root };
}

test('pack carries every reference, including the m7/m10 files in the wasm crate, and unpack restores them in place', (context) => {
  const base = scratch(context);
  const { temp, root } = nativeOutputs(base);
  const files = pack(join(base, 'pack'), temp, root);
  assert.deepEqual(Object.keys(files).sort(), ['crate/m7-native-reference.output.json', 'temp/m3-native-openings.json', 'temp/native-compare/products.tsv', 'temp/native-references/m5-native-clips.json']);
  const consumer = { temp: join(base, 'c-temp'), root: join(base, 'c-root') };
  unpack(join(base, 'pack'), consumer.temp, consumer.root);
  assert.equal(readFileSync(join(consumer.root, 'rust/wasm-bindings/m7-native-reference.output.json'), 'utf8'), '[7]');
  assert.equal(readFileSync(join(consumer.temp, 'native-references/m5-native-clips.json'), 'utf8'), '[1]');
  assert.equal(readFileSync(join(consumer.temp, 'native-compare/products.tsv'), 'utf8'), 'model\tid\tms\n1\t2\t3\n');
});

test('unpack refuses a file whose bytes changed in transport, before writing anything', (context) => {
  const base = scratch(context);
  const { temp, root } = nativeOutputs(base);
  pack(join(base, 'pack'), temp, root);
  writeFileSync(join(base, 'pack/temp/m3-native-openings.json'), '{"a":2}');
  assert.throws(() => unpack(join(base, 'pack'), join(base, 'c-temp'), join(base, 'c-root')), /does not match its pack manifest/);
  assert.throws(() => readFileSync(join(base, 'c-root/rust/wasm-bindings/m7-native-reference.output.json')), /ENOENT/);
});

test('an empty pack still has a manifest, so its upload never fails for want of files', (context) => {
  const base = scratch(context);
  assert.deepEqual(pack(join(base, 'pack'), join(base, 'nothing'), join(base, 'root')), {});
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'pack/manifest.json'), 'utf8')).files, {});
});

const ok = (ids) => Object.fromEntries(ids.map((id) => [id, { outcome: 'success', conclusion: 'success' }]));

test('a lane job is green only when its status and every lane step it owns are', () => {
  const steps = ok(jobLaneSteps('na-native'));
  assert.equal(verdict('na-native', 'success', steps).ok, true);
  assert.deepEqual(verdict('na-native', 'failure', steps).problems, ['job status failure']);
  // continue-on-error makes the step's conclusion success; its outcome is what failed.
  const red = { ...steps, 'finish-join': { outcome: 'failure', conclusion: 'success' } };
  assert.deepEqual(verdict('na-native', 'success', red).problems, ['finish-join=failure']);
  const absent = { ...steps };
  delete absent['m3-native'];
  assert.deepEqual(verdict('na-native', 'success', absent).problems, ['m3-native=absent']);
  assert.throws(() => verdict('native-adapter', 'success', {}), /unknown split job/);
});

/** `toJSON(needs)` for an all-green split on one commit. */
const greenNeeds = () => Object.fromEntries(SPLIT_LANE_JOBS.map((job) => [job, {
  result: 'success', outputs: { verdict: 'success', head: 'a'.repeat(40), steps: JSON.stringify(ok(jobLaneSteps(job))) },
}]));

test('the judge passes only when every lane job succeeded, on one commit', () => {
  const j = judge(greenNeeds());
  assert.equal(j.ok, true, j.problems.join('; '));
  assert.deepEqual(j.lanes.map((l) => l.lane), LANES.map((l) => l.lane));
  assert.ok(j.lanes.some((l) => l.lane === 'FINISH_JOIN' && l.outcome === 'success'));
});

test('the judge fails a skipped job, a masked failure, a missing verdict or two commits', () => {
  const skipped = greenNeeds();
  skipped['na-viewer'] = { result: 'skipped', outputs: {} };
  assert.ok(judge(skipped).problems.includes('na-viewer: result skipped'));
  // Job-level continue-on-error: the result reads success, the job's own verdict does not.
  const masked = greenNeeds();
  masked['na-wasm'].outputs.verdict = 'failure';
  assert.ok(judge(masked).problems.includes('na-wasm: verdict failure'));
  const noVerdict = greenNeeds();
  delete noVerdict['na-browser'].outputs.verdict;
  assert.ok(judge(noVerdict).problems.includes('na-browser: verdict absent'));
  const twoCommits = greenNeeds();
  twoCommits['na-native'].outputs.head = 'b'.repeat(40);
  assert.ok(judge(twoCommits).problems.some((p) => p.startsWith('lane jobs ran different commits')));
  const missing = greenNeeds();
  delete missing['na-cli-parity'];
  assert.ok(judge(missing).problems.includes('na-cli-parity: not in needs'));
  // A lane split over two jobs is red when either half is.
  const half = greenNeeds();
  half['na-cli-parity'].outputs.steps = JSON.stringify({ ...ok(jobLaneSteps('na-cli-parity')), 'cli-parity': { outcome: 'failure' } });
  assert.ok(judge(half).problems.includes('CLI_RETAINED=failure'));
});

test('every lane maps the single job\'s lane to split steps the lane jobs own', () => {
  for (const job of SPLIT_LANE_JOBS) assert.ok(jobLaneSteps(job).length > 0, job);
  for (const lane of LANES) for (const [job] of lane.split) assert.ok(SPLIT_LANE_JOBS.includes(job), `${lane.lane}: ${job}`);
});

test('the timing-free hash ignores timing fields and nothing else', () => {
  const tsv = (ms, volume) => Buffer.from(`model\tid\tms\tvolume_m3\tcutMs\nA\t1\t${ms}\t${volume}\t${ms}\n`);
  assert.equal(timingFreeHash('products.tsv', tsv(10, 2)), timingFreeHash('products.tsv', tsv(99, 2)));
  assert.notEqual(timingFreeHash('products.tsv', tsv(10, 2)), timingFreeHash('products.tsv', tsv(10, 3)));
  const json = (ms, v) => Buffer.from(JSON.stringify([{ id: 1, volume: v, phasesMs: { clipMs: ms }, affine_ms: ms }]));
  assert.equal(timingFreeHash('m.json', json(1, 2)), timingFreeHash('m.json', json(5, 2)));
  assert.notEqual(timingFreeHash('m.json', json(1, 2)), timingFreeHash('m.json', json(1, 2.5)));
});

test('timings inside text (Rust Instant, *_ms fields, Durations) do not count, the rest does', () => {
  const tsv = (sec, nsec) => Buffer.from(`model\tmessage\nA\tRefused { start: Instant { tv_sec: ${sec}, tv_nsec: ${nsec} }, duration: 3.2ms, code: 7 }\n`);
  assert.equal(timingFreeHash('products.tsv', tsv(1726, 490621224)), timingFreeHash('products.tsv', tsv(2012, 449990582)));
  assert.notEqual(timingFreeHash('products.tsv', tsv(1, 1)), timingFreeHash('products.tsv', Buffer.from('model\tmessage\nA\tRefused { code: 8 }\n')));
  const json = (rss, ms) => Buffer.from(JSON.stringify({ retained: { processMaxRssKiB: rss, productMilliseconds: ms, published: 2 } }));
  assert.equal(timingFreeHash('s.json', json(74820, 950.9)), timingFreeHash('s.json', json(74596, 683.9)));
  // The viewer's per-load model UUID and the raw products.tsv hash are run-dependent; the model name is not.
  const viewer = (id, sha, name) => Buffer.from(JSON.stringify({ model: { id, name }, nativeProductsSha256: sha }));
  assert.equal(timingFreeHash('r.json', viewer('573e9f49-b653-4617-825f-32c70c137488', 'aa', 'A.ifc')), timingFreeHash('r.json', viewer('059a0902-0c68-4e7c-a81a-a94bb63b759f', 'bb', 'A.ifc')));
  assert.notEqual(timingFreeHash('r.json', viewer('573e9f49-b653-4617-825f-32c70c137488', 'aa', 'A.ifc')), timingFreeHash('r.json', viewer('573e9f49-b653-4617-825f-32c70c137488', 'aa', 'B.ifc')));
  // Load-trace spans and drawn-frame counts are telemetry; captured output compares as a multiset of lines.
  const viewerRecord = (spans, draws, output, triangles) => Buffer.from(JSON.stringify({ spans, draws, output, shards: [{ triangles }] }));
  assert.equal(timingFreeHash('s.json', viewerRecord(['a', 'b'], 1, '(node:30931) Warning\n- x\n- y\n at f (vite.config.ts.timestamp-1795108932722-6a4fbbf269381.mjs:247:24)', 12)), timingFreeHash('s.json', viewerRecord(['b', 'a', 'b'], 2, '(node:11107) Warning\n- y\n- x\n at f (vite.config.ts.timestamp-1795107135978-880e7ec5e58e5.mjs:247:24)', 12)));
  assert.notEqual(timingFreeHash('s.json', viewerRecord([], 1, '- x\n- y', 12)), timingFreeHash('s.json', viewerRecord([], 1, '- x', 12)));
  assert.notEqual(timingFreeHash('s.json', viewerRecord([], 1, '- x', 12)), timingFreeHash('s.json', viewerRecord([], 1, '- x', 13)));
  const layers = (p95, hits) => Buffer.from(JSON.stringify({ layers: { bandMsP95: p95, count: 3 }, phases: { point_cache_hits: hits } }));
  assert.equal(timingFreeHash('s.json', layers(463.5, 1090)), timingFreeHash('s.json', layers(304.9, 1084)));
  const line = (ms) => `sdk witness executed: m8 issue_3641 mask=0 codes_volumes=[(1, Some(2.5))] timings=NativeTimings { startup_and_qualification_ms: ${ms}, construction_count: 4 }\n`;
  assert.deepEqual([...markers(line(2540.358216), []).keys()], [...markers(line(1835.304595), []).keys()]);
  assert.notDeepEqual([...markers(line(1), []).keys()], [...markers(line(1).replace('Some(2.5)', 'Some(2.6)'), []).keys()]);
});

/**
 * One m11-n model, one published part: the unit square z=0 (face 0, surface 7) as
 * two triangles, plus the triangle (0,0,1)-(1,0,1)-(0,1,1) (face 1, surface 8).
 * `diagonal` 1 splits the square along 1-3 instead of 0-2; `order` reorders
 * triangles; `vertexOrder` permutes the vertex list (indices follow).
 */
const m11n = ({ diagonal = 0, order = null, vertexOrder = null, edit = () => {} } = {}) => {
  const verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1]];
  let tris = [...(diagonal ? [[0, 1, 3], [1, 2, 3]] : [[0, 1, 2], [0, 2, 3]]).map((idx) => ({ idx, face: 0, surface: 7, n: [0, 0, 1] })), { idx: [4, 5, 6], face: 1, surface: 8, n: [0, 0, 1] }];
  if (order) tris = order.map((i) => tris[i]);
  const perm = vertexOrder ?? verts.map((_, i) => i); // new position -> old vertex
  const where = new Map(perm.map((old, now) => [old, now]));
  const part = {
    frame: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    positions: perm.flatMap((old) => verts[old]), indices: tris.flatMap((t) => t.idx.map((i) => where.get(i))),
    normals: tris.flatMap((t) => [t.n, t.n, t.n].flat()), revisionLocalFaces: tris.map((t) => t.face), surfaceIndices: tris.map((t) => t.surface),
  };
  edit(part);
  return Buffer.from(JSON.stringify([{ model: 'm.ifc', ids: null, source: 'x', rows: [{ id: 96, status: 'published', sourceSurfaces: [], parts: [part] }, { id: 6, status: 'refused', code: 'c' }] }]));
};

test('m11-n compares by mesh invariants: SMLib order and quad diagonals do not count, geometry does', () => {
  const same = (b) => sameReference('temp/m11-n-native.json', m11n(), b);
  // What SMLib's address-keyed ordering changes between runs: a match.
  assert.equal(same(m11n({ order: [2, 1, 0] })), true, 'reordered triangles');
  assert.equal(same(m11n({ vertexOrder: [6, 5, 4, 3, 2, 1, 0] })), true, 'reordered vertices');
  assert.equal(same(m11n({ diagonal: 1, order: [1, 2, 0], vertexOrder: [3, 0, 1, 2, 6, 4, 5] })), true, 'other diagonal, reordered');
  // What must not change: a mismatch.
  assert.equal(same(m11n({ edit: (p) => { p.positions[3] = 1.5; } })), false, 'moved vertex');
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(3, 3); p.normals.splice(9, 9); p.revisionLocalFaces.splice(1, 1); p.surfaceIndices.splice(1, 1); } })), false, 'missing triangle');
  assert.equal(same(m11n({ edit: (p) => { p.indices.push(4, 5, 6); p.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1); p.revisionLocalFaces.push(1); p.surfaceIndices.push(8); } })), false, 'extra triangle');
  assert.equal(same(m11n({ edit: (p) => { p.normals[2] = -1; } })), false, 'changed normal');
  assert.equal(same(m11n({ edit: (p) => { p.surfaceIndices[2] = 9; } })), false, 'changed face-surface mapping');
  assert.equal(same(m11n({ edit: (p) => { p.frame[12] = 2; } })), false, 'changed frame');
  // Three triangles on one face: [7,7,8] -> [7,8,8] keeps the set of surfaces, not the count per surface.
  const three = (surfaces) => m11n({ edit: (p) => { p.revisionLocalFaces = [0, 0, 0]; p.surfaceIndices = surfaces; } });
  assert.equal(sameReference('temp/m11-n-native.json', three([7, 7, 8]), three([7, 8, 8])), false, 'triangle moved to another surface');
  assert.equal(sameReference('temp/m11-n-native.json', three([7, 7, 8]), three([7, 7, 8])), true);
  // Same vertices, counts, normals and surfaces, but the square only half covered (a degenerate triangle): the area check.
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(3, 3, 0, 2, 2); } })), false, 'face area');
  // The #10858 review counter-example: [0,1,2],[0,2,3] -> two copies of [0,1,2] keeps the vertex multiset,
  // the counts, the normals, the surface counts and (two halves of a unit square) the summed area.
  const halfGone = m11n({ edit: (p) => { p.indices.splice(3, 3, 0, 1, 2); } });
  assert.equal(same(halfGone), false, 'half a face replaced by a duplicate triangle');
  assert.equal(sameReference('temp/m11-n-native.json', halfGone, halfGone), false, 'a duplicate triangle fails even against itself');
  // The third review counter-example: two triangles of one face trading surfaces ([7,8] -> [8,7]), or corner normals.
  const twoSurfaces = (surfaces) => m11n({ edit: (p) => { p.surfaceIndices = [...surfaces, 8]; } });
  assert.equal(sameReference('temp/m11-n-native.json', twoSurfaces([7, 8]), twoSurfaces([8, 7])), false, 'triangles swap source surfaces');
  const swappedNormals = m11n({ edit: (p) => { p.normals.splice(0, 3, 0, 1, 0); p.normals.splice(9, 3, 0, 1, 0); } });
  const sameNormalsElsewhere = m11n({ edit: (p) => { p.normals.splice(3, 3, 0, 1, 0); p.normals.splice(12, 3, 0, 1, 0); } });
  assert.equal(sameReference('temp/m11-n-native.json', swappedNormals, sameNormalsElsewhere), false, 'a corner normal moves to another position');
  // Each face carries the set of positions its triangles use (here the square's four corners, then face 1's three).
  const faces = m11nInvariants(JSON.parse(m11n().toString())).exact[0].rows[0].parts[0].faces;
  assert.deepEqual(faces.map(([id, , , , used]) => [id, used]), [[0, ['[0,0,0]', '[0,1,0]', '[1,0,0]', '[1,1,0]']], [1, ['[0,0,1]', '[0,1,1]', '[1,0,1]']]]);
  // The square's outline is its four sides, walked counter-clockwise, whichever diagonal splits it.
  const outline = ['[0,0,0]>[1,0,0]', '[0,1,0]>[0,0,0]', '[1,0,0]>[1,1,0]', '[1,1,0]>[0,1,0]'];
  for (const diagonal of [0, 1]) assert.deepEqual(m11nInvariants(JSON.parse(m11n({ diagonal }).toString())).exact[0].rows[0].parts[0].faces[0][5], outline, `diagonal ${diagonal}`);
  // Three of a face's triangles on one edge (0-1: [0,1,2], [0,1,3] and [0,1,5]) is a defect.
  const fanOn01 = (p) => { for (const v of [3, 5]) { p.indices.push(0, 1, v); p.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1); p.revisionLocalFaces.push(0); p.surfaceIndices.push(7); } };
  assert.equal(m11nInvariants(JSON.parse(m11n({ edit: fanOn01 }).toString())).defects.some((d) => d.includes('shared by 3 triangles')), true, 'edge shared by three triangles');
  // The same over several surfaces of one face (#10858 review): 7, 8 and 9 each use 0-1 once, the face three times.
  const fanAcross = (p) => { for (const [v, surface] of [[3, 8], [5, 9]]) { p.indices.push(0, 1, v); p.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1); p.revisionLocalFaces.push(0); p.surfaceIndices.push(surface); } };
  assert.equal(m11nInvariants(JSON.parse(m11n({ edit: fanAcross }).toString())).defects.some((d) => d.includes('face 0: edge') && d.includes('shared by 3 triangles')), true, 'edge shared by three triangles over three surfaces');
  // Winding across an interior edge (#10858 review): two triangles of one face that walk their shared edge the
  // same way hold a flipped one, wherever it sits, so a flip in either copy fails even where the outline and the
  // count against the normals agree. The square's diagonal 0-2: [0,1,2] walks 2>0, [0,2,3] 0>2; [0,3,2] walks 2>0 too.
  const flippedInner = m11n({ edit: (p) => { p.indices.splice(3, 3, 0, 3, 2); } });
  assert.equal(m11nInvariants(JSON.parse(flippedInner.toString())).defects.some((d) => d.includes('walked the same way by both of its triangles')), true, 'interior edge walked twice the same way');
  assert.equal(sameReference('temp/m11-n-native.json', flippedInner, flippedInner), false, 'a flipped interior triangle fails even against itself');
  for (const diagonal of [0, 1]) assert.deepEqual(m11nInvariants(JSON.parse(m11n({ diagonal }).toString())).defects, [], `consistent winding, diagonal ${diagonal}`);
  // Moving face 1's triangle onto the square's positions changes that set (and the area).
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(6, 3, 0, 1, 2); } })), false, 'face 1 uses other positions');
  // The second review counter-example: [0,1,2],[0,1,3] covers one half twice and leaves the other empty,
  // with the same positions, counts, normals, surfaces and area and no duplicate or flat triangle. Its outline differs.
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(3, 3, 0, 1, 3); } })), false, 'overlapping triangles leave part of the face empty');
  // A zero-area triangle fails on its own.
  const flat = m11n({ edit: (p) => { p.indices.push(0, 1, 1); p.normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1); p.revisionLocalFaces.push(0); p.surfaceIndices.push(7); } });
  assert.equal(sameReference('temp/m11-n-native.json', flat, flat), false, 'zero-area triangle');
  // A non-mesh field still compares exactly.
  assert.equal(sameReference('temp/m11-n-native.json', m11n(), Buffer.from(m11n().toString().replace('"refused"', '"published"'))), false, 'row status');
  // Orientation (#10858 review): reversing a triangle keeps its undirected edges, corners and
  // unsigned area, but its front face turns. Isolated face 1 [4,5,6] -> [4,6,5], normals unchanged:
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(6, 3, 4, 6, 5); } })), false, 'reversed isolated triangle');
  // One half of the square reversed ([0,1,2] -> [0,2,1]), also under the other diagonal:
  assert.equal(same(m11n({ edit: (p) => { p.indices.splice(0, 3, 0, 2, 1); } })), false, 'reversed half of the square');
  assert.equal(same(m11n({ diagonal: 1, edit: (p) => { p.indices.splice(0, 3, 0, 3, 1); } })), false, 'reversed half, other diagonal');
  // Every triangle reversed together with its normals: the outline walks the other way, still a mismatch.
  const allFlipped = m11n({ edit: (p) => { for (let t = 0; t < p.indices.length; t += 3) [p.indices[t + 1], p.indices[t + 2]] = [p.indices[t + 2], p.indices[t + 1]]; p.normals = p.normals.map((x) => -x); } });
  assert.equal(same(allFlipped), false, 'whole mesh flipped with its normals');
  // Without normals the directed outline still catches a reversal.
  const bare = (edit = () => {}) => m11n({ edit: (p) => { delete p.normals; edit(p); } });
  assert.equal(sameReference('temp/m11-n-native.json', bare(), bare((p) => p.indices.splice(6, 3, 4, 6, 5))), false, 'reversed, no normals');
  // Reordering, rotating each triangle's corners and the other diagonal still match, winding kept.
  const rotated = m11n({ diagonal: 1, order: [2, 0, 1], vertexOrder: [5, 3, 0, 6, 1, 4, 2], edit: (p) => { for (let t = 0; t < p.indices.length; t += 3) p.indices.splice(t, 3, p.indices[t + 1], p.indices[t + 2], p.indices[t]); } });
  assert.equal(same(rotated), true, 'reordered, rotated corners, other diagonal');
  const faceAgainst = (b) => m11nInvariants(JSON.parse(b.toString())).exact[0].rows[0].parts[0].faces.map((f) => f[6]);
  assert.deepEqual(faceAgainst(m11n()), [0, 0]);
  assert.deepEqual(faceAgainst(m11n({ edit: (p) => { p.indices.splice(6, 3, 4, 6, 5); } })), [0, 1]);
  // Only m11-n is compared this way: the same reorder elsewhere still differs.
  assert.equal(sameReference('temp/m11-t-native-surface.json', m11n(), m11n({ order: [2, 1, 0] })), false);
});

test('markers reads native witness lines and registered cli/viewer records, through reporter decoration', () => {
  const text = '\u001b[32m# sdk witness executed: m8 real browser Worker parity\u001b[0m\nℹ cli-witness-x {"a":1}\nnoise\n';
  const found = markers(text, ['cli-witness-x', 'absent-one']);
  assert.deepEqual([...found.keys()].sort(), ['cli-witness-x', 'm8 real browser Worker parity']);
  assert.equal(found.get('m8 real browser Worker parity'), null);
  // A record's content is compared without its volatile fields, and not without the rest.
  const record = (payload) => markers(`cli-witness-x ${JSON.stringify(payload)}\n`, ['cli-witness-x']).get('cli-witness-x');
  assert.equal(record({ published: 3, startupMs: 1, wasmHeapPeakBytes: 9 }), record({ published: 3, startupMs: 7, wasmHeapPeakBytes: 2 }));
  assert.notEqual(record({ published: 3 }), record({ published: 4 }));
});

/** Collected evidence for both layouts, all green and identical unless `edit` changes it. */
function layouts(base, edit = () => {}) {
  const env = { STEPS_JSON: '', JOB_STATUS: 'success' };
  const { temp, root } = nativeOutputs(join(base, 'n'));
  // collect reads `git rev-parse` from root: give both a repository on one commit.
  cpSync(join(REPO, '.gitignore'), join(root, '.gitignore'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x']);
  put(join(temp, 'retained-browser.log'), 'sdk witness executed: m10_browser_parity\n');
  put(join(temp, 'cli-real-authoring.log'), '# M2-D cli-real-archicad: {"published":12,"compared":3}\n');
  put(join(temp, 'viewer-retained/summary.json'), '{"published":12,"msPerProduct":{"p50":4},"browserMemory":{"used":1}}');
  put(join(temp, 'viewer-retained/e2e/real-archicad.json'), '{"meshes":40}');
  const monoSteps = Object.fromEntries(LANES.filter((l) => l.mono).map((l) => [l.mono, { outcome: 'success' }]));
  monoSteps['retained-clippy'] = { outcome: 'success' };
  collect('native-adapter', join(base, 'mono'), temp, { ...env, STEPS_JSON: JSON.stringify(monoSteps) }, root);
  // na-native produced the references; na-browser and na-cli-parity restored them from its pack.
  pack(join(base, 'xfer'), temp, root);
  const restored = join(base, 'restored');
  unpack(join(base, 'xfer'), restored, root);
  const tempOf = (job) => (job === 'na-native' ? temp : ['na-browser', 'na-cli-parity'].includes(job) ? restored : join(base, 'empty'));
  for (const job of SPLIT_LANE_JOBS) collect(job, join(base, 'split', `na-split-evidence-${job}`), tempOf(job), { ...env, STEPS_JSON: JSON.stringify(ok(jobLaneSteps(job))) }, root);
  edit(base);
  return { mono: join(base, 'mono'), split: join(base, 'split'), needs: { 'native-adapter': { result: 'success' }, ...greenNeeds(), [SPLIT_JUDGE]: { result: 'success' } }, root: REPO };
}

test('identical layouts match, with the split-only M1 reference and marker allowed', async (context) => {
  const base = scratch(context);
  const input = layouts(base, (b) => {
    put(join(b, 'split/na-split-evidence-na-native/logs/retained-browser.log'), 'sdk witness executed: m10_browser_parity\nsdk witness executed: m1_browser_parity\n');
    // Produced by na-native and restored by both consumers; the single job never writes it.
    for (const job of ['na-native', 'na-browser', 'na-cli-parity']) {
      const dir = join(b, `split/na-split-evidence-${job}`);
      const manifest = JSON.parse(readFileSync(join(dir, 'refs/manifest.json'), 'utf8'));
      put(join(dir, 'refs/temp/native-references/m1-native-unit-rectangle.json'), '{"fixture":"unit-rectangle-1m","volume":1}');
      manifest.files['temp/native-references/m1-native-unit-rectangle.json'] = 'x';
      writeFileSync(join(dir, 'refs/manifest.json'), JSON.stringify(manifest));
    }
  });
  const report = await compareLayouts(input);
  assert.equal(report.match, true, report.markdown);
  assert.match(report.markdown, /\*\*MATCH\*\*/);
});

test('a lane, a witness, a reference or a verdict that differs is a mismatch', async (context) => {
  const lane = await compareLayouts(layouts(scratch(context), (b) => {
    const p = join(b, 'split/na-split-evidence-na-wasm/steps.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), 'generated-types': { outcome: 'failure' } }));
  }));
  assert.ok(lane.problems.includes('lane GENERATED_TYPES: single success, split failure'), lane.markdown);
  const witness = await compareLayouts(layouts(scratch(context), (b) => put(join(b, 'split/na-split-evidence-na-native/logs/retained-browser.log'), 'nothing\n')));
  assert.ok(witness.problems.includes('witness markers differ in retained-browser.log'), witness.markdown);
  const reference = await compareLayouts(layouts(scratch(context), (b) => put(join(b, 'split/na-split-evidence-na-native/refs/temp/m3-native-openings.json'), '{"a":9}')));
  assert.ok(reference.problems.includes('reference temp/m3-native-openings.json differs'), reference.markdown);
  // A timing column alone is not a difference.
  const timing = await compareLayouts(layouts(scratch(context), (b) => put(join(b, 'split/na-split-evidence-na-native/refs/temp/native-compare/products.tsv'), 'model\tid\tms\n1\t2\t999\n')));
  assert.equal(timing.match, true, timing.markdown);
  const input = layouts(scratch(context));
  input.needs['native-adapter'].result = 'failure';
  const verdicts = await compareLayouts(input);
  assert.ok(verdicts.problems.some((p) => p.startsWith('verdicts differ')), verdicts.markdown);
});

test('cli/viewer record content, browser outputs and an empty transport are compared too', async (context) => {
  const evidence = (b, job) => join(b, 'split', `na-split-evidence-${job}`);
  const record = await compareLayouts(layouts(scratch(context), (b) => put(join(evidence(b, 'na-native'), 'logs/cli-real-authoring.log'), '# M2-D cli-real-archicad: {"published":11,"compared":3}\n')));
  assert.ok(record.problems.includes('witness record M2-D cli-real-archicad: content differs in cli-real-authoring.log'), record.markdown);
  // Only volatile fields differ: still a match.
  const volatile = await compareLayouts(layouts(scratch(context), (b) => put(join(evidence(b, 'na-native'), 'outputs/viewer-retained/summary.json'), '{"published":12,"msPerProduct":{"p50":99},"browserMemory":{"used":5}}')));
  assert.equal(volatile.match, true, volatile.markdown);
  const output = await compareLayouts(layouts(scratch(context), (b) => put(join(evidence(b, 'na-native'), 'outputs/viewer-retained/e2e/real-archicad.json'), '{"meshes":39}')));
  assert.ok(output.problems.includes('output viewer-retained/e2e/real-archicad.json differs'), output.markdown);
  const lost = await compareLayouts(layouts(scratch(context), (b) => {
    for (const job of SPLIT_LANE_JOBS) rmSync(join(evidence(b, job), 'outputs'), { recursive: true, force: true });
  }));
  assert.ok(lost.problems.includes('output viewer-retained/summary.json missing from the split'), lost.markdown);
  const twice = await compareLayouts(layouts(scratch(context), (b) => put(join(evidence(b, 'na-wasm'), 'logs/retained-browser.log'), 'sdk witness executed: m10_browser_parity\n')));
  assert.ok(twice.problems.includes('log retained-browser.log comes from more than one split job (na-native, na-wasm)'), twice.markdown);
  const empty = await compareLayouts(layouts(scratch(context), (b) => writeFileSync(join(evidence(b, 'na-browser'), 'refs/manifest.json'), '{"files":{}}')));
  assert.ok(empty.problems.includes('na-browser restored no reference at all'), empty.markdown);
  assert.ok(empty.problems.some((p) => p.startsWith('na-browser did not restore 4 of na-native')), empty.markdown);
});

test('an unreadable output is a named problem, and every other file is still compared', async (context) => {
  const evidence = (b, job) => join(b, 'split', `na-split-evidence-${job}`);
  const report = await compareLayouts(layouts(scratch(context), (b) => {
    put(join(evidence(b, 'na-native'), 'outputs/viewer-retained/e2e/real-archicad.json'), '{"meshes":4');
    put(join(evidence(b, 'na-native'), 'outputs/viewer-retained/summary.json'), '{"published":11}');
  }));
  assert.ok(report.problems.some((p) => p.startsWith('output viewer-retained/e2e/real-archicad.json unreadable in na-native')), report.markdown);
  assert.ok(report.problems.includes('output viewer-retained/summary.json differs'), report.markdown);
  assert.match(report.markdown, /\| viewer-retained\/e2e\/real-archicad\.json \| \*\*unreadable\*\* \|/);
  const ref = await compareLayouts(layouts(scratch(context), (b) => put(join(evidence(b, 'na-native'), 'refs/temp/m3-native-openings.json'), '{"a":')));
  assert.ok(ref.problems.some((p) => p.startsWith('reference temp/m3-native-openings.json unreadable')), ref.markdown);
});

test('a red single job stopped halfway: outputs and logs only the split wrote are reported, not counted', async (context) => {
  const halfway = (input) => {
    const p = join(input.mono, 'steps.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), 'viewer-retained': { outcome: 'failure' } }));
    input.needs['native-adapter'].result = 'failure';
    return input;
  };
  const cut = (b) => {
    rmSync(join(b, 'mono/logs/cli-real-authoring.log'));
    rmSync(join(b, 'mono/outputs/viewer-retained/e2e/real-archicad.json'));
    put(join(b, 'mono/outputs/viewer-retained/summary.json'), '{"published":');
  };
  const red = await compareLayouts(halfway(layouts(scratch(context), cut)));
  assert.ok(!red.problems.some((p) => p.startsWith('log ') || p.startsWith('output ')), red.markdown);
  assert.match(red.markdown, /cli-real-authoring\.log: only in split \(single job red: reported, not counted\)/);
  // The verdict still differs (single red, split green): a red run is never a match on its own.
  assert.ok(red.problems.some((p) => p.startsWith('verdicts differ')), red.markdown);
  // On a green single job the same gaps count.
  const green = await compareLayouts(layouts(scratch(context), cut));
  assert.ok(green.problems.includes('log cli-real-authoring.log missing from the single job'), green.markdown);
  assert.ok(green.problems.includes('output viewer-retained/e2e/real-archicad.json only in the split'), green.markdown);
  assert.ok(green.problems.some((p) => p.startsWith('output viewer-retained/summary.json unreadable in the single job')), green.markdown);
});

test('missing evidence from either layout is a mismatch, never an empty match', async (context) => {
  const noMono = await compareLayouts(layouts(scratch(context), (b) => rmSync(join(b, 'mono'), { recursive: true })));
  assert.equal(noMono.match, false);
  assert.ok(noMono.problems.some((p) => p.startsWith('no evidence from native-adapter')), noMono.markdown);
  const noSplit = await compareLayouts(layouts(scratch(context), (b) => rmSync(join(b, 'split'), { recursive: true })));
  assert.equal(noSplit.match, false);
  for (const job of SPLIT_LANE_JOBS) assert.ok(noSplit.problems.some((p) => p.startsWith(`no evidence from ${job}`)), job);
});

test('a lane the single job never reached is reported, not counted', async (context) => {
  const report = await compareLayouts(layouts(scratch(context), (b) => {
    const p = join(b, 'mono/steps.json');
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), 'm3-browser': { outcome: 'skipped' }, 'retained-clippy': { outcome: 'skipped' } }));
  }));
  assert.equal(report.match, true, report.markdown);
  assert.match(report.markdown, /\| FINISH_JOIN \| not reached \| success \|/);
});

test('timings come from the run\'s jobs listing when a token is present', async (context) => {
  const input = layouts(scratch(context));
  const at = (m) => new Date(Date.UTC(2026, 10, 19, 0, m)).toISOString();
  const jobs = [
    { name: 'native-adapter', started_at: at(0), completed_at: at(60) },
    ...SPLIT_LANE_JOBS.map((name, i) => ({ name, started_at: at(i), completed_at: at(20 + i) })),
    { name: 'na-split-judge', started_at: at(30), completed_at: at(32) },
  ];
  const fetchImpl = async (url) => { assert.match(url, /\/runs\/7\/attempts\/1\/jobs/); return { ok: true, json: async () => ({ jobs }) }; };
  const report = await compareLayouts({ ...input, env: { GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' }, fetchImpl });
  assert.equal(report.match, true, report.markdown);
  assert.equal(report.timings.monoMinutes, 60);
  assert.equal(report.timings.splitCriticalMinutes, 32);
  assert.equal(report.timings.splitRunnerMinutes, 6 * 20 + 2);
});

test('a failed jobs-listing request costs the timings, never the comparison', async (context) => {
  const input = layouts(scratch(context));
  const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const report = await compareLayouts({ ...input, env: { GH_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' }, fetchImpl });
  assert.equal(report.match, true, report.markdown);
  assert.match(report.timings.note, /jobs listing failed \(getaddrinfo ENOTFOUND\); timings not read/);
  assert.match(report.markdown, /\*\*MATCH\*\*/);
});

test('green lanes under a red or absent judge job are no green split', async (context) => {
  for (const judgeJob of [{ result: 'failure' }, undefined]) {
    const input = layouts(scratch(context));
    if (judgeJob) input.needs[SPLIT_JUDGE] = judgeJob; else delete input.needs[SPLIT_JUDGE];
    const report = await compareLayouts(input);
    assert.equal(report.match, false, report.markdown);
    assert.ok(report.problems.includes(`${SPLIT_JUDGE} result ${judgeJob?.result ?? 'absent'}: the split has no verdict of its own`), report.markdown);
    assert.ok(report.problems.includes('verdicts differ: single green, split red'), report.markdown);
  }
});
