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
import { jobLaneSteps, judge, LANES, SPLIT_LANE_JOBS } from './lib/native-adapter-split.mjs';
import { compareLayouts, markers, timingFreeHash } from './lib/native-adapter-split-compare.mjs';

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

test('markers reads native witness lines and registered cli/viewer records, through reporter decoration', () => {
  const text = '\u001b[32m# sdk witness executed: m8 real browser Worker parity\u001b[0m\nℹ cli-witness-x {"a":1}\nnoise\n';
  assert.deepEqual([...markers(text, ['cli-witness-x', 'absent-one'])].sort(), ['cli-witness-x', 'm8 real browser Worker parity']);
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
  const monoSteps = Object.fromEntries(LANES.filter((l) => l.mono).map((l) => [l.mono, { outcome: 'success' }]));
  monoSteps['retained-clippy'] = { outcome: 'success' };
  collect('native-adapter', join(base, 'mono'), temp, { ...env, STEPS_JSON: JSON.stringify(monoSteps) }, root);
  for (const job of SPLIT_LANE_JOBS) collect(job, join(base, 'split', `na-split-evidence-${job}`), job === 'na-native' ? temp : join(base, 'empty'), { ...env, STEPS_JSON: JSON.stringify(ok(jobLaneSteps(job))) }, root);
  edit(base);
  return { mono: join(base, 'mono'), split: join(base, 'split'), needs: { 'native-adapter': { result: 'success' }, ...greenNeeds() }, root: REPO };
}

test('identical layouts match, with the split-only M1 reference and marker allowed', async (context) => {
  const base = scratch(context);
  const input = layouts(base, (b) => {
    const native = join(b, 'split/na-split-evidence-na-native');
    put(join(native, 'logs/retained-browser.log'), 'sdk witness executed: m10_browser_parity\nsdk witness executed: m1_browser_parity\n');
    const manifest = JSON.parse(readFileSync(join(native, 'refs/manifest.json'), 'utf8'));
    put(join(native, 'refs/temp/native-references/m1-native-unit-rectangle.json'), '{"fixture":"unit-rectangle-1m","volume":1}');
    manifest.files['temp/native-references/m1-native-unit-rectangle.json'] = 'x';
    writeFileSync(join(native, 'refs/manifest.json'), JSON.stringify(manifest));
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
  assert.equal(report.timings.monoMinutes, 60);
  assert.equal(report.timings.splitCriticalMinutes, 32);
  assert.equal(report.timings.splitRunnerMinutes, 6 * 20 + 2);
});
