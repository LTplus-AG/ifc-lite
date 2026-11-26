/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shadow comparison of the two native-adapter layouts on one commit: the
 * single `native-adapter` job against the split lane jobs. Report only; the
 * flip to the split needs repeated matching runs of this (see the PR that added it).
 *
 *   - verdicts: the monolith's job result against the strict judge's, and each
 *     judged lane's outcome. A lane the monolith never reached (skipped after a
 *     hard failure there) is reported, not counted: the split still runs it.
 *   - witnesses: the set of `sdk witness executed:` markers, and of the
 *     registered cli/viewer markers, per log file; for the cli/viewer records
 *     also their JSON payload, with volatile fields removed.
 *   - references: sha256 of every native reference and comparison product, raw
 *     and with volatile fields removed (products.tsv carries `ms`/`cutMs`; some
 *     references carry `*Ms` phases). Only the volatile-free hash decides.
 *   - browser/viewer outputs: browser.test.mjs's summary.json and products.tsv
 *     and the viewer records under viewer-retained/, volatile-free.
 *   - transport: each consumer job restored every file na-native packed,
 *     byte-equal; restoring nothing is a failure.
 *   - timings: from the run's jobs listing when a token is available.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { requiredWitnesses } from '../check-retained-witnesses.mjs';
import { judge, LANES, SPLIT_JUDGE, SPLIT_LANE_JOBS, splitLaneOutcome } from './native-adapter-split.mjs';

/** Only the split has these, by design: the M1 reference and browser parity the single job never fed. */
export const SPLIT_ONLY_MARKERS = { 'retained-browser.log': ['m1_browser_parity'] };
export const SPLIT_ONLY_REFS = ['temp/native-references/m1-native-unit-rectangle.json'];
/**
 * Fields that differ between two runs of the same commit: timings (`ms`, `*_ms`,
 * `*Ms`, `*MsP95`, `*Milliseconds`, `msPer*`, `timings`), memory (`*Bytes`, `*RssKiB`,
 * `browserMemory`), cache counters (`*_cache_hits`/`_misses`) and timestamps (`*At`).
 * Measured in the first dispatched run (44547513676).
 */
// nativeProductsSha256 hashes the raw products.tsv, whose ms/cutMs columns differ every run
// (that table itself is compared without them). The viewer records' `spans` (load-trace
// telemetry; their number varies with scheduling) and `draws` (frames drawn while polling;
// the test asserts only > 0) count frames, not results.
export const VOLATILE_KEY = /(?:^ms$|_ms$|Ms(?:P\d+)?$|Milliseconds$|^milliseconds$|^msPer|^timings?$|Bytes$|RssKiB$|^browserMemory$|_cache_(?:hits|misses)$|At$|^nativeProductsSha256$|^spans$|^draws$)/;

/**
 * The same, inside text: Rust Debug output carries `Instant { tv_sec: …, tv_nsec: … }`
 * in refusal messages and `…_ms: 12.3` in witness lines, the viewer gives every
 * loaded model a random UUID (`model.id`), and captured output carries the node pid
 * and Vite's timestamped temp-config name. The value becomes `_`.
 */
export const stripVolatileText = (text) => text
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '_uuid_')
  .replace(/\(node:\d+\)/g, '(node:_)')
  // Vite's per-start temp config name in stack traces: vite.config.ts.timestamp-<ms>-<hex>.mjs
  .replace(/\.timestamp-\d+-[0-9a-f]+\.mjs/g, '.timestamp-_.mjs')
  .replace(/\b(tv_sec|tv_nsec|secs|nanos): \d+/g, '$1: _')
  .replace(/\b([A-Za-z_]*(?:_ms|Ms|Milliseconds|milliseconds)): -?[\d.]+(?:e[+-]?\d+)?/g, '$1: _')
  .replace(/\b(duration|elapsed): [\d.]+(?:ns|µs|us|ms|s)\b/g, '$1: _');
const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback);
const digest = (text) => createHash('sha256').update(text).digest('hex');

/** `value` with every volatile field removed, at any depth. */
// A record's captured process `output` prints the build's warnings in varying order:
// compared as a multiset of lines, every line still counted.
const LINES_AS_MULTISET = new Set(['output']);
export const stripVolatile = (v) => (Array.isArray(v) ? v.map(stripVolatile) : typeof v === 'string' ? stripVolatileText(v) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE_KEY.test(k)).map(([k, x]) => [k, LINES_AS_MULTISET.has(k) && typeof x === 'string'
    ? stripVolatileText(x).split('\n').sort().join('\n') : stripVolatile(x)])) : v);

/**
 * m11-n-native.json is compared by its mesh INVARIANTS, not its bytes (owner
 * decision 2026-11-19, after the root-cause investigation). The pinned SMLib
 * orders Boolean and tessellation output by object address, which follows heap
 * layout and ASLR: six ordinary runs gave six distinct files, while the worker
 * alone with ASLR off always gave one. In run 44547513676 three Boolean products
 * differed: issue_2019 #30 (same triangles, other order) and f-e #96 and f-f #1003,
 * whose vertex and polygon order differ AND some planar quads are split along the
 * other diagonal. No sorted-triangle form can match those, so per part this
 * compares what stayed identical across every observed run, exactly:
 *   - the frame and every non-mesh field;
 *   - the multiset of vertex positions and the triangle count;
 *   - per face (revisionLocalFaces) AND source surface (surfaceIndices), so a
 *     triangle cannot move to another surface unseen: the triangle count, the
 *     set of (position, corner normal) pairs (a vertex keeps its normal under any
 *     diagonal, so swapped normals differ), the set of vertex POSITIONS its
 *     triangles use, and its BOUNDARY: the edges (position pairs) exactly one of
 *     its triangles uses. Another diagonal keeps a face's outline, so this does not
 *     depend on triangulation; [0,1,2],[0,1,3] in a square (one half covered twice,
 *     the other empty, same area) changes it (#10858 review);
 *   - ORIENTATION, per face as well: the boundary edges are DIRECTED (the sense
 *     its triangles walk them), and the number of triangles whose winding normal
 *     points against their summed corner normals. Reversing a triangle ([0,1,2] ->
 *     [0,2,1]) keeps its undirected edges, corners and unsigned area, so without
 *     these a flipped front face compared equal (#10858 review). Both survive
 *     reordering and the other diagonal: a consistently wound quad walks its
 *     outline the same way under either split, and every triangle keeps its side;
 * as a coverage check, each face's total triangle area within 1e-9 relative;
 * and, in each copy on its own, no face may hold two triangles with the same
 * three positions, no edge may be shared by more than two of a face's
 * triangles, and no triangle may have zero area. Without those two, a face
 * [0,1,2],[0,2,3] rewritten as [0,1,2],[0,1,2] kept every invariant above (#10858
 * review): half the face went missing and still compared equal. Any such defect
 * fails the comparison. None of this depends on triangle order or diagonals.
 * The producer is unchanged here. Keep this until #10916 (canonical meshes)
 * proves byte determinism; then compare m11-n by its bytes again.
 */
export const M11N_AREA_RELATIVE = 1e-9;

export function m11nInvariants(reference) {
  const areas = [];
  const defects = [];
  const part = (p) => {
    if (!Array.isArray(p?.indices) || !Array.isArray(p?.positions)) return p;
    const { positions, indices, normals, revisionLocalFaces, surfaceIndices, ...rest } = p;
    const xyz = (list, i) => list.slice(i * 3, i * 3 + 3);
    const vertices = [];
    for (let v = 0; v * 3 < positions.length; v += 1) vertices.push(JSON.stringify(xyz(positions, v)));
    // Grouped by (face, source surface): a triangle cannot trade surfaces with another one unseen.
    const faces = new Map();
    const seen = new Map();
    // Per face id across its surfaces: the manifold and winding checks below are about the face, not one surface of it.
    const faceEdges = new Map();
    for (let t = 0; t * 3 < indices.length; t += 1) {
      const id = revisionLocalFaces?.[t] ?? null;
      const surface = surfaceIndices?.[t] ?? null;
      const group = JSON.stringify([id, surface]);
      const face = faces.get(group) ?? { id, surface, triangles: 0, corners: new Set(), area: 0, used: new Set(), edges: new Map(), directed: new Map(), against: 0 };
      face.triangles += 1;
      const [a, b, c] = [0, 1, 2].map((k) => xyz(positions, indices[t * 3 + k]));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cross = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const area = Math.hypot(...cross) / 2;
      face.area += area;
      // Winding against the corner normals: a reversed triangle turns its front face away.
      if (Array.isArray(normals)) {
        const n = [0, 1, 2].map((k) => xyz(normals, t * 3 + k)).reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]);
        if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) face.against += 1;
      }
      const corners = [a, b, c].map((q) => JSON.stringify(q));
      // A corner normal belongs to its position (any diagonal keeps it): pairs, not a bare normal set.
      for (let k = 0; k < 3; k += 1) face.corners.add(JSON.stringify([[a, b, c][k], Array.isArray(normals) ? xyz(normals, t * 3 + k) : null]));
      for (const q of corners) face.used.add(q);
      const whole = faceEdges.get(id) ?? new Map();
      faceEdges.set(id, whole);
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) {
        const edge = [corners[i], corners[j]].sort().join('|');
        face.edges.set(edge, (face.edges.get(edge) ?? 0) + 1);
        const walks = whole.get(edge) ?? [];
        walks.push(`${corners[i]}>${corners[j]}`);
        whole.set(edge, walks);
        const directed = `${corners[i]}>${corners[j]}`;
        face.directed.set(directed, (face.directed.get(directed) ?? 0) + 1);
      }
      const key = [...corners].sort().join('|');
      const faceSeen = seen.get(id) ?? new Set();
      if (faceSeen.has(key)) defects.push(`face ${id}: two triangles on the same three positions ${key}`);
      faceSeen.add(key);
      seen.set(id, faceSeen);
      if (!(area > 0)) defects.push(`face ${id}: zero-area triangle ${corners.join(' ')}`);
      faces.set(group, face);
    }
    const groups = [...faces.keys()].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
    for (const g of groups) areas.push(faces.get(g).area);
    for (const [id, whole] of faceEdges) {
      for (const [edge, walks] of whole) {
        if (walks.length > 2) defects.push(`face ${id}: edge ${edge} shared by ${walks.length} triangles`);
        // Two consistently wound triangles walk their shared edge in opposite senses; the same sense twice is a flipped one.
        else if (walks.length === 2 && walks[0] === walks[1]) defects.push(`face ${id}: edge ${edge} walked the same way by both of its triangles`);
      }
    }
    // Directed: the boundary is walked in the winding's sense, so a reversed triangle on it reverses an edge.
    const boundary = (face) => [...face.directed.keys()].filter((d) => face.edges.get(d.split('>').sort().join('|')) === 1).sort();
    return {
      ...rest, vertices: vertices.sort(), triangleCount: indices.length / 3,
      faces: groups.map((g) => { const f = faces.get(g); return [f.id, f.surface, f.triangles, [...f.corners].sort(), [...f.used].sort(), boundary(f), f.against]; }),
    };
  };
  const exact = reference.map((model) => ({ ...model, rows: model.rows?.map((row) => (Array.isArray(row.parts) ? { ...row, parts: row.parts.map(part) } : row)) }));
  return { exact, areas, defects };
}

/** References compared by invariants instead of bytes, named one by one (see m11nInvariants). */
export const BY_INVARIANTS = { 'm11-n-native.json': m11nInvariants };

/** Whether two copies of reference `rel` agree: by invariants where named, otherwise by volatile-free hash. */
export function sameReference(rel, aBytes, bBytes) {
  const invariants = BY_INVARIANTS[rel.split('/').at(-1)];
  if (!invariants) return timingFreeHash(rel, aBytes) === timingFreeHash(rel, bBytes);
  const [a, b] = [aBytes, bBytes].map((x) => invariants(JSON.parse(x.toString('utf8'))));
  if (a.defects.length || b.defects.length) return false;
  if (JSON.stringify(stripVolatile(a.exact)) !== JSON.stringify(stripVolatile(b.exact)) || a.areas.length !== b.areas.length) return false;
  return a.areas.every((x, i) => Math.abs(x - b.areas[i]) <= M11N_AREA_RELATIVE * Math.max(Math.abs(x), Math.abs(b.areas[i])));
}

/** sha256 of a reference or output with its volatile fields (columns, keys) removed. */
export function timingFreeHash(name, bytes) {
  if (name.endsWith('.tsv')) {
    const rows = bytes.toString('utf8').split('\n').map((l) => l.split('\t'));
    const keep = rows[0].map((h, i) => (VOLATILE_KEY.test(h) ? -1 : i)).filter((i) => i >= 0);
    return digest(rows.map((r) => keep.map((i) => stripVolatileText(r[i] ?? '')).join('\t')).join('\n'));
  }
  if (name.endsWith('.json')) return digest(JSON.stringify(stripVolatile(JSON.parse(bytes.toString('utf8')))));
  return digest(bytes);
}

/**
 * Every witness marker in one log, mapped to its record's content: null for a
 * native-style line, the volatile-free sha256 of the JSON payload for a
 * registered cli/viewer record (sorted and joined if the record repeats).
 */
export function markers(text, registered) {
  const found = new Map();
  for (const raw of stripVTControlCharacters(text).split(/\r?\n/)) {
    const line = raw.replace(/^(?:# |ℹ )/, '');
    const native = line.match(/sdk witness executed: (.+?)\s*$/);
    // Some native witness lines print their own timings: compare the line without them.
    if (native && !found.has(stripVolatileText(native[1]))) found.set(stripVolatileText(native[1]), null);
    for (const m of registered) {
      if (!line.startsWith(`${m} `)) continue;
      let payload;
      try { payload = digest(JSON.stringify(stripVolatile(JSON.parse(line.slice(m.length + 1))))); } catch { payload = `unparseable:${digest(line)}`; }
      found.set(m, [...new Set([...(found.get(m)?.split(',') ?? []), payload])].sort().join(','));
    }
  }
  return found;
}

/** Relative paths of every file under `dir`, sorted. */
const filesUnder = (dir, prefix = '') => (existsSync(join(dir, prefix)) ? readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? filesUnder(dir, join(prefix, e.name)) : e.isFile() ? [join(prefix, e.name)] : []).sort() : []);

/** One evidence directory (collect's layout): steps, logs and the refs pack manifest. */
function evidence(dir) {
  return {
    steps: readJson(join(dir, 'steps.json'), {}),
    meta: readJson(join(dir, 'meta.json'), {}),
    refs: readJson(join(dir, 'refs', 'manifest.json'), { files: {} }).files,
    logs: existsSync(join(dir, 'logs')) ? readdirSync(join(dir, 'logs')).sort() : [],
    outputs: filesUnder(join(dir, 'outputs')),
    // collect always writes meta.json, so its absence means the evidence never arrived.
    present: existsSync(join(dir, 'meta.json')),
    dir,
  };
}

const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

async function timings(env, fetchImpl = globalThis.fetch) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT = '1', GITHUB_API_URL = 'https://api.github.com' } = env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return { note: 'no token or run id; timings not read' };
  // Timings are report-only: a failed request must never cost the evidence verdict.
  let jobs;
  try {
    const res = await fetchImpl(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { note: `jobs listing HTTP ${res.status}; timings not read` };
    jobs = (await res.json()).jobs ?? [];
  } catch (err) {
    return { note: `jobs listing failed (${err?.message ?? err}); timings not read` };
  }
  const find = (id) => jobs.find((j) => j.name === id || j.name?.endsWith(` / ${id}`));
  const done = (j) => j?.started_at && j?.completed_at;
  const mono = find('native-adapter');
  const lanes = SPLIT_LANE_JOBS.map((id) => [id, find(id)]);
  const judgeJob = find(SPLIT_JUDGE);
  const out = { perJob: {} };
  if (done(mono)) out.monoMinutes = minutes(mono.started_at, mono.completed_at);
  for (const [id, j] of [...lanes, [SPLIT_JUDGE, judgeJob]]) if (done(j)) out.perJob[id] = { start: j.started_at, minutes: minutes(j.started_at, j.completed_at) };
  const started = lanes.filter(([, j]) => done(j)).map(([, j]) => j.started_at).sort();
  if (started.length > 0 && done(judgeJob)) out.splitCriticalMinutes = minutes(started[0], judgeJob.completed_at);
  out.splitRunnerMinutes = Object.values(out.perJob).reduce((s, j) => s + j.minutes, 0);
  return out;
}

/** The whole comparison; `match` is false on any verdict, lane, witness or timing-free hash difference. */
export async function compareLayouts({ mono: monoDir, split: splitDir, needs, root, env = {}, fetchImpl }) {
  const problems = [];
  const lines = ['## native-adapter: single job vs split (shadow)', ''];
  const mono = evidence(monoDir);
  const split = Object.fromEntries(SPLIT_LANE_JOBS.map((job) => [job, evidence(join(splitDir, `na-split-evidence-${job}`))]));
  // Absent evidence reads as empty steps, logs and references: never let it certify a match.
  for (const [label, e] of [['native-adapter', mono], ...Object.entries(split)]) if (!e.present) problems.push(`no evidence from ${label} (${e.dir}); nothing of it was compared`);
  const monoGreen = needs?.['native-adapter']?.result === 'success';
  const j = judge(needs);
  // The judge job is the split's verdict: green lanes under a red or absent judge job are not a green split.
  const judgeResult = needs?.[SPLIT_JUDGE]?.result ?? 'absent';
  const splitGreen = j.ok && judgeResult === 'success';
  lines.push(`Verdict: single job **${needs?.['native-adapter']?.result ?? 'absent'}**, split judge **${splitGreen ? 'success' : 'failure'}**`);
  if (judgeResult !== 'success') problems.push(`${SPLIT_JUDGE} result ${judgeResult}: the split has no verdict of its own`);
  if (monoGreen !== splitGreen) problems.push(`verdicts differ: single ${monoGreen ? 'green' : 'red'}, split ${splitGreen ? 'green' : 'red'}${j.problems.length ? ` (${j.problems.join('; ')})` : ''}`);
  for (const id of new Set(SPLIT_LANE_JOBS.map((job) => split[job].meta.head).filter(Boolean))) if (mono.meta.head && id !== mono.meta.head) problems.push(`split job commit ${id} is not the single job's ${mono.meta.head}`);

  lines.push('', '| lane | single job | split |', '|---|---|---|');
  const stepsByJob = Object.fromEntries(SPLIT_LANE_JOBS.map((job) => [job, split[job].steps]));
  for (const lane of LANES) {
    const s = splitLaneOutcome(lane, stepsByJob);
    // FINISH_JOIN has no id in the single job: it passed if the step after it ran.
    const m = lane.mono ? (mono.steps[lane.mono]?.outcome ?? 'absent') : (['success', 'failure'].includes(mono.steps['retained-clippy']?.outcome) ? 'success' : 'not reached');
    const counted = m !== 'skipped' && m !== 'not reached';
    lines.push(`| ${lane.lane} | ${m} | ${s} |${m !== s && counted ? ' **differs**' : ''}`);
    if (m !== s && counted) problems.push(`lane ${lane.lane}: single ${m}, split ${s}`);
  }

  lines.push('', '### Witness markers per log');
  const registered = [...(await requiredWitnesses(root, 'cli')), ...(await requiredWitnesses(root, 'viewer'))].map((w) => w.marker);
  const logNames = [...new Set([...mono.logs, ...SPLIT_LANE_JOBS.flatMap((job) => split[job].logs)])].sort();
  for (const name of logNames) {
    const read = (e) => (e.logs.includes(name) ? markers(readFileSync(join(e.dir, 'logs', name), 'utf8'), registered) : null);
    const a = read(mono);
    const owners = SPLIT_LANE_JOBS.filter((job) => split[job].logs.includes(name));
    // One writer per log in the split; two would let one copy mask the other.
    if (owners.length > 1) problems.push(`log ${name} comes from more than one split job (${owners.join(', ')})`);
    const b = owners.length ? new Map(owners.flatMap((job) => [...read(split[job])])) : null;
    // A red single job stops a combined step halfway, where the split still runs the later half in another job:
    // on a red run a log in one layout only is reported, and the lane outcomes above decide.
    if (a === null || b === null) {
      lines.push(`- ${name}: only in ${a === null ? 'split' : 'single job'}${monoGreen ? '' : ' (single job red: reported, not counted)'}`);
      if (monoGreen) problems.push(`log ${name} missing from the ${a === null ? 'single job' : 'split'}`);
      continue;
    }
    const extra = [...b.keys()].filter((x) => !a.has(x) && !(SPLIT_ONLY_MARKERS[name] ?? []).includes(x));
    const lost = [...a.keys()].filter((x) => !b.has(x));
    const changed = [...a.keys()].filter((x) => b.has(x) && a.get(x) !== b.get(x));
    lines.push(`- ${name} (${owners.join(', ')}): ${a.size} single, ${b.size} split${lost.length ? `; **missing in split**: ${lost.join(', ')}` : ''}${extra.length ? `; **split only**: ${extra.join(', ')}` : ''}${changed.length ? `; **record content differs**: ${changed.join(', ')}` : ''}`);
    if (lost.length || extra.length) problems.push(`witness markers differ in ${name}`);
    for (const m of changed) problems.push(`witness record ${m} content differs in ${name}`);
  }

  lines.push('', '### References (sha256; m11-n by mesh invariants)', '', '| file | raw equal | volatile-free equal |', '|---|---|---|');
  const native = split['na-native'];
  for (const rel of [...new Set([...Object.keys(mono.refs), ...Object.keys(native.refs)])].sort()) {
    if (!mono.refs[rel] && SPLIT_ONLY_REFS.includes(rel)) { lines.push(`| ${rel} | split only (by design) | - |`); continue; }
    if (!mono.refs[rel] || !native.refs[rel]) { lines.push(`| ${rel} | only in ${mono.refs[rel] ? 'single job' : 'split'} | - |`); problems.push(`reference ${rel} produced by one layout only`); continue; }
    let same;
    try { same = sameReference(rel, readFileSync(join(mono.dir, 'refs', rel)), readFileSync(join(native.dir, 'refs', rel))); } catch (err) {
      lines.push(`| ${rel} | ${mono.refs[rel] === native.refs[rel] ? 'yes' : 'no'} | **unreadable** |`);
      problems.push(`reference ${rel} unreadable (${err?.message ?? err})`);
      continue;
    }
    lines.push(`| ${rel} | ${mono.refs[rel] === native.refs[rel] ? 'yes' : 'no'} | ${same ? 'yes' : '**no**'} |`);
    if (!same) problems.push(`reference ${rel} differs`);
  }
  for (const job of ['na-browser', 'na-cli-parity']) {
    const got = split[job].refs;
    const bad = Object.entries(got).filter(([rel, h]) => native.refs[rel] && native.refs[rel] !== h).map(([rel]) => rel);
    const missing = Object.keys(native.refs).filter((rel) => !got[rel]);
    const restored = Object.keys(got).filter((rel) => native.refs[rel] === got[rel]).length;
    lines.push(`- transport to ${job}: ${restored} file(s) byte-equal to na-native's${bad.length ? `; **altered** ${bad.join(', ')}` : ''}${missing.length ? `; **not restored** ${missing.join(', ')}` : ''}`);
    if (bad.length) problems.push(`references altered in transport to ${job}`);
    if (missing.length) problems.push(`${job} did not restore ${missing.length} of na-native's ${Object.keys(native.refs).length} reference(s)`);
    if (restored === 0) problems.push(`${job} restored no reference at all`);
  }

  lines.push('', '### Browser and viewer outputs (viewer-retained/, volatile-free)', '', '| file | equal |', '|---|---|');
  // Counted only when the single job's viewer step succeeded: a failed one stops partway, and its outputs then
  // cover only what ran before the failure (the VIEWER_RETAINED lane outcome above still compares).
  const reached = mono.steps['viewer-retained']?.outcome === 'success';
  // A truncated or unparseable file is a problem of its own, named with its layout (counted like any
  // output, so not after a failed viewer step, which can leave one half-written); the rest is still compared.
  const hashOf = (rel, dir, layout) => {
    try { return timingFreeHash(rel, readFileSync(join(dir, 'outputs', rel))); } catch (err) {
      if (reached) problems.push(`output ${rel} unreadable in ${layout} (${err?.message ?? err})`);
      return null;
    }
  };
  const ownerOf = (rel) => SPLIT_LANE_JOBS.find((job) => split[job].outputs.includes(rel));
  for (const rel of [...new Set([...mono.outputs, ...SPLIT_LANE_JOBS.flatMap((job) => split[job].outputs)])].sort()) {
    const owner = ownerOf(rel);
    const inMono = mono.outputs.includes(rel);
    const hashes = inMono && owner ? [hashOf(rel, mono.dir, 'the single job'), hashOf(rel, split[owner].dir, owner)] : [];
    const unreadable = hashes.includes(null);
    const same = hashes.length === 2 && !unreadable && hashes[0] === hashes[1];
    lines.push(`| ${rel} | ${!inMono ? 'split only' : !owner ? 'single job only' : unreadable ? '**unreadable**' : same ? 'yes' : '**no**'} |`);
    if (unreadable) continue;
    if (reached && !same) problems.push(`output ${rel} ${!inMono ? 'only in the split' : !owner ? 'missing from the split' : 'differs'}`);
  }

  const t = await timings(env, fetchImpl);
  lines.push('', '### Timings (minutes)');
  if (t.note) lines.push(`- ${t.note}`);
  else {
    lines.push(`- single job: ${t.monoMinutes?.toFixed(1) ?? '?'}; split critical path (first lane start to judge end): ${t.splitCriticalMinutes?.toFixed(1) ?? '?'}; split runner minutes: ${t.splitRunnerMinutes.toFixed(1)}`);
    for (const [id, x] of Object.entries(t.perJob)) lines.push(`  - ${id}: ${x.minutes.toFixed(1)} (started ${x.start})`);
  }
  lines.push('', problems.length ? `**MISMATCH** (${problems.length}):\n${problems.map((p) => `- ${p}`).join('\n')}` : '**MATCH**: same verdicts, lanes, witnesses and references.', '');
  return { match: problems.length === 0, problems, markdown: lines.join('\n'), timings: t };
}
