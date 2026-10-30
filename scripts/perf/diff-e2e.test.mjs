/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: finite protocol, identity, fixture and lifecycle invariants. No engines,
// model parsing, timing samples or benchmark admission are used by these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { protocol, validateProtocol, digest, nonempty, resultProof,
  assertPair, distribution, fixtureInvariant, endpointVerdict, cohortVerdict, planningEstimate } from './diff-e2e-protocol.mjs';
import { fileReceipt, readJson, inventory, harnessReceipt, validateBuildReceipt, validateResolved, runtimeReceipt } from './diff-e2e-receipts.mjs';
import { measure } from './diff-e2e-sample.mjs';
import { main, run, summary, audit, cpuUtilization } from './diff-e2e.mjs';

test('#8042 protocol requires six pairs, reproducible balanced interleaving and finite bounds', () => {
  const p = protocol();
  assert.equal(p.pairs, 6);
  assert.deepEqual(p.cases.map(c => c.id), ['demo', 'haus', 'large']);
  assert.equal(p.options.length, 3);
  assert.deepEqual(p.execution.optionOrder, [2]);
  assert.equal(protocol({ pairs: 1, dryRun: true }).cases.length, 2);
  assert.deepEqual(validateProtocol(p), p);
  assert.deepEqual(protocol(), p);
  assert.equal(p.order.filter(pair => pair[0] === 'base').length, 3);
  assert.ok(p.order.every(pair => new Set(pair).size === 2));
  for (const pairs of [0, 1, 5, 7, 26, Infinity, NaN, 5.5]) assert.throws(() => protocol({ pairs }));
  for (const retained of [0, 11, Infinity]) assert.throws(() => protocol({ retained }));
  assert.throws(() => protocol({ largeBase: '/a' }));
  assert.throws(() => protocol({ seed: 42 }));
  assert.throws(() => validateProtocol({ ...p, options: [{ scope: 'geometry' }] }));
  assert.throws(() => validateProtocol({ ...p, limits: { ...p.limits, rows: Infinity } }));
  assert.throws(() => validateProtocol({ ...p, cases: p.cases.slice(0, 1) }));
});

test('#8042 empty input cannot yield a vacuous identity/performance result', () => {
  assert.throws(() => nonempty([]), /fingerprint count/);
  const input = [{ key: 'a', ref: 7, ifcType: 'IfcWall', dataHash: 'hash', components: { p: 'x' } }];
  const unchanged = { counts: { unchanged: 1, added: 0, deleted: 0, modified: 0 } };
  fixtureInvariant({ id: 'haus' }, unchanged, input, input);
  assert.throws(() => fixtureInvariant({ id: 'haus' }, unchanged, [...input, ...input], input), /lost entities/);
  assert.throws(() => fixtureInvariant({ id: 'demo' }, unchanged, input, input), /real change/);
  assert.throws(() => fixtureInvariant({ id: 'large' }, unchanged, input, input), /real change/);
  // #8042: controlled IFC revisions may exercise edits or rekey/content paths.
  for (const counts of [
    { unchanged: 0, added: 0, deleted: 0, modified: 1 },
    { unchanged: 0, added: 1, deleted: 1, modified: 0 },
  ]) fixtureInvariant({ id: 'large' }, { counts }, input, input);
  assert.throws(() => resultProof({ entries: [] }, input, input), /nonempty diff/);
});

test('#8042 result hash preserves order, optional properties, maps and nonfinite host values', () => {
  for (const [a, b] of [[{}, { optional: undefined }], [0, -0], [NaN, null],
    [Infinity, 'Infinity'], [[1, 2], [2, 1]], [new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]])]]) {
    assert.notEqual(digest(a), digest(b));
  }
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest('\ud800'), digest('\ufffd'));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => digest(cycle), /cyclic/);
});

function resultFixture() {
  const base = [{ key: 'a', ref: { opaque: true } }], head = [{ key: 'a', ref: { opaque: true } }];
  const entry = { key: 'a', base: base[0], head: head[0], state: 'unchanged', changeKinds: [] };
  const result = { scope: 'data', entries: [entry], byKey: new Map([['a', entry]]), counts: { unchanged: 1 },
    contentMatches: [{ base, head }], splitMerges: [{ kind: 'split', whole: base[0], pieces: head }],
    successors: [{ base: base[0], head: head[0] }] };
  return { base, head, result };
}

test('#8042 proof rejects copied row/entry objects even when deeply equal', () => {
  const { base, head, result } = resultFixture();
  const good = resultProof(result, base, head);
  const same = resultFixture();
  assert.deepEqual(good, resultProof(same.result, same.base, same.head));
  result.byKey.set('extra', result.entries[0]);
  assert.throws(() => resultProof(result, base, head), /exactly the entries/);
  result.byKey.delete('extra');
  const original = result.entries[0].base;
  result.entries[0].base = { ...original };
  assert.throws(() => resultProof(result, base, head), /identity lost/);
  result.entries[0].base = original;
  result.byKey.set('a', { ...result.entries[0] });
  assert.throws(() => resultProof(result, base, head), /reuse entry/);
});

test('#8042 all secondary claim references must point into their proper side', () => {
  for (const mutate of [
    f => { f.result.contentMatches[0].head = [{ ...f.head[0] }]; },
    f => { f.result.splitMerges[0].whole = f.head[0]; },
    f => { f.result.splitMerges[0].excluded = f.base[0]; },
    f => { f.result.successors[0].base = f.head[0]; },
  ]) {
    const f = resultFixture(); mutate(f);
    assert.throws(() => resultProof(f.result, f.base, f.head));
  }
});

test('#8042 paired identity compares fingerprint payload and full result, not counts alone', () => {
  const base = { rows: [1, 1], inputHashes: ['a', 'b'], proofs: [{ sha256: 'c', counts: { unchanged: 1 } }] };
  assertPair(base, structuredClone(base));
  assert.throws(() => assertPair(base, { ...base, rows: [0, 0] }));
  assert.throws(() => assertPair(base, { ...base, inputHashes: ['different', 'b'] }));
  assert.throws(() => assertPair(base, { ...base, proofs: [{ sha256: 'different', counts: { unchanged: 1 } }] }));
});

test('#8042 distributions report samples and correct even/odd medians without an acceptance verdict', () => {
  assert.deepEqual(distribution([5, 1, 3, 2, 4]), { n: 5, min: 1, median: 3, p95: 5, max: 5, samples: [5, 1, 3, 2, 4] });
  assert.equal(distribution([4, 1, 3, 2]).median, 2.5);
  assert.throws(() => distribution([]));
  assert.throws(() => distribution([Infinity]));
});

test('#8042 plan generation runs with no fixtures/builds and refuses overwriting evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-e2e-unit-'));
  try {
    const path = join(dir, 'protocol.json');
    await main(['plan', '--out', path]);
    const { value, receipt } = await readJson(path);
    assert.deepEqual(value, protocol());
    assert.equal(receipt.sha256.length, 64);
    await assert.rejects(main(['plan', '--out', path]), { code: 'EEXIST' });
    await writeFile(join(dir, 'empty.ifc'), '');
    await assert.rejects(fileReceipt(join(dir, 'empty.ifc')), /empty or oversized/);
    await writeFile(join(dir, 'large.ifc'), 'abcd');
    await assert.rejects(fileReceipt(join(dir, 'large.ifc'), 3), /empty or oversized/);
    await assert.rejects(fileReceipt(join(dir, 'missing.ifc')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#8042 process summaries do not promote correlated repeats to independent samples', () => {
  const sample = values => ({ phases: { lifecycleTotalMs: 20 }, processWallMs: 30,
    maxRssKiB: 1, retainedTimes: values.map(totalMs => ({ totalMs })) });
  const value = summary([{ base: sample([1, 1, 100]), branch: sample([2, 2, 200]) },
    { base: sample([3, 3, 300]), branch: sample([6, 6, 600]) }]);
  assert.equal(value.base.warmProcessMediansMs.n, 2);
  assert.deepEqual(value.base.warmProcessMediansMs.samples, [1, 3]);
  assert.deepEqual(value.pairedWarmCallRatio.samples, [2, 2]);
});

test('#8042 production facade is called once cold and per warm repeat; proof never enters timing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-facade-unit-'));
  const gc = global.gc;
  try {
    await writeFile(join(dir, 'a.ifc'), 'inert fixture');
    let calls = 0, inits = 0, releases = 0;
    global.gc = () => { releases++; };
    const base = [{ key: 'a', ref: {} }], head = [{ key: 'a', ref: {} }];
    let side = 0;
    const modules = {
      'packages/cli/dist/loader.js': { parseIfcBytes: () => ({}), scanCompletenessWarnings: () => [] },
      'packages/cli/dist/commands/diff-engine.js': { buildFileFingerprints: () => [base, head][side++] },
      'packages/diff/dist/index.js': { initDiff: () => { inits++; }, diffModels: (_b, _h) => {
        calls++;
        // Accessing entries would throw: timing must not traverse/hash output.
        return { get entries() { throw new Error('proof contaminated timing'); } };
      } },
    };
    const payload = { root: dir, fixture: { id: 'unit', paths: [join(dir, 'a.ifc'), join(dir, 'a.ifc')] },
      options: [{}, {}, {}], retained: 3, implementation: 'rust-wasm', optionIndex: 1 };
    const cold = await measure({ ...payload, mode: 'cold' }, name => modules[name]);
    assert.equal(calls, 1); assert.equal(inits, 1); assert.equal(releases, 1);
    assert.deepEqual(cold.proofs, []); assert.equal(cold.retainedTimes.length, 0);
    side = 0;
    const warm = await measure({ ...payload, mode: 'warm' }, name => modules[name]);
    assert.equal(calls, 5); assert.equal(inits, 2); assert.equal(releases, 2);
    assert.equal(warm.retainedTimes.length, 3);
    assert.ok(warm.phases.lifecycleTotalMs >= warm.phases.releaseMs);
    side = 0;
    modules['packages/diff/dist/index.js'] = { diffModels() { throw new Error('must not run'); } };
    await assert.rejects(measure({ ...payload, mode: 'cold' }, name => modules[name]), /final public Rust facade/);
  } finally { global.gc = gc; await rm(dir, { recursive: true, force: true }); }
});

test('#8042 exact source build, dependency bytes and actual resolver paths are required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-build-unit-'));
  try {
    const file = join(dir, 'runtime.js'); await writeFile(file, 'export const version = 1;');
    const r = await fileReceipt(file);
    const inv = { root: dir, runtime: await runtimeReceipt(), source: { commit: 'exact', tree: 'tree' }, implementation: 'rust-wasm',
      artifacts: { 'runtime.js': r, 'pnpm-lock.yaml': r }, dependencies: { [file]: r } };
    const build = { version: 'ifc-diff-build/1', status: 'succeeded', exitCode: 0,
      freshOutputs: true, root: dir, source: inv.source, implementation: inv.implementation,
      runtime: inv.runtime, originalReceipt: r,
      commands: ['root pnpm build after deleting generated outputs with turbo cache disabled'], workerCommand: ['unit-build'],
      toolchain: 'pinned toolchain', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
      outputs: inv.artifacts, dependencies: inv.dependencies };
    const execution = { state: 'completed', exitCode: 0, sourceUnchanged: true,
      sourceAfter: { ...inv.source, clean: true, toolchainInputs: { 'pnpm-lock.yaml': r.sha256 } }, artifacts: { 'manifest.json': r.sha256 }, cwd: dir, command: build.workerCommand };
    execution.sourceBefore = execution.sourceAfter;
    build.outputManifestReceipt = r;
    const { originalReceipt, outputManifestReceipt, ...manifest } = build;
    assert.equal(originalReceipt, r); assert.equal(outputManifestReceipt, r);
    validateBuildReceipt(build, inv, r, execution, manifest, r);
    for (const bad of [{ ...execution, state: 'failed' }, { ...execution, exitCode: 1 },
      { ...execution, sourceUnchanged: false }, { ...execution, artifacts: {} }]) {
      assert.throws(() => validateBuildReceipt(build, inv, r, bad, manifest, r));
    }
    for (const patch of [{ status: 'failed' }, { exitCode: 1 }, { freshOutputs: false },
      { source: { commit: 'other' } }, { outputs: {} }, { dependencies: {} }, { commands: [] },
      { runtime: { node: 'other' } }, { originalReceipt: {} }]) {
      assert.throws(() => validateBuildReceipt({ ...build, ...patch }, inv, r, execution, { ...manifest, ...patch }, r));
    }
    await validateResolved([file], inv, {});
    await assert.rejects(validateResolved([], inv, {}), /resolution/);
    const foreign = join(dir, 'foreign.js'); await writeFile(foreign, 'unprepared');
    await assert.rejects(validateResolved([foreign], inv, {}), /unprepared/);
    await writeFile(file, 'stale or replaced binary');
    await assert.rejects(validateResolved([file], inv, {}), /unprepared/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#8042 cohort requires frozen bindings and keeps separate proof failure evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-e2e-cohort-unit-'));
  const root = join(dir, 'source');
  try {
    await mkdir(root);
    for (const path of ['packages/cli/dist/loader.js', 'packages/cli/dist/commands/diff-engine.js',
      'packages/diff/dist/index.js', 'packages/diff/dist/wasm-runtime.js',
      'packages/diff/dist/wasm-columns.js', 'packages/diff/dist/wasm-result.js',
      'packages/wasm/pkg-diff/ifc-lite-diff.js', 'packages/wasm/pkg-diff/ifc-lite-diff_bg.wasm',
      'pnpm-lock.yaml', 'package.json']) {
      const full = join(root, path); await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, 'unit receipt fixture\n');
    }
    const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git(['init', '-q']); git(['add', '.']);
    git(['-c', 'user.name=Harness test', '-c', 'user.email=harness@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unit fixture']);
    const originalPath = join(dir, 'original.json');
    const preparation = {}, inventories = {};
    const runtimePath = join(root, 'packages/diff/dist/index.js');
    for (const [arm, implementation] of [['base', 'typescript'], ['branch', 'rust-wasm']]) {
      const inv = await inventory(root, implementation, [runtimePath]); inventories[arm] = inv;
      const path = join(dir, `${arm}.json`), receipt = join(dir, `${arm}.build.json`);
      await writeFile(path, JSON.stringify(inv));
      const manifest = { version: 'ifc-diff-build/1', status: 'succeeded', exitCode: 0,
        freshOutputs: true, root, implementation, source: inv.source,
        runtime: inv.runtime, commands: ['unit fixture build'], workerCommand: ['unit-build'],
        toolchain: 'unit', startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
        outputs: inv.artifacts, dependencies: inv.dependencies };
      const manifestPath = join(dir, `${arm}.outputs.json`); await writeFile(manifestPath, JSON.stringify(manifest));
      const outputManifestReceipt = await fileReceipt(manifestPath);
      const workerPath = join(dir, `${arm}.worker.json`);
      const identity = { ...inv.source, clean: true, toolchainInputs: { 'pnpm-lock.yaml': inv.artifacts['pnpm-lock.yaml'].sha256 } };
      await writeFile(workerPath, JSON.stringify({ state: 'completed', exitCode: 0, sourceUnchanged: true,
        sourceBefore: identity, sourceAfter: identity, cwd: root, command: manifest.workerCommand, artifacts: { 'outputs.json': outputManifestReceipt.sha256 } }));
      await writeFile(receipt, JSON.stringify({ ...manifest, outputManifestReceipt, originalReceipt: await fileReceipt(workerPath) }));
      preparation[arm] = { inventory: path, receipt };
    }
    const protocolPath = join(dir, 'protocol.json'), admissionPath = join(dir, 'admission.json');
    const fixtureRoot = join(dir, 'fixtures');
    const demo = join(fixtureRoot, 'apps/viewer/public/samples'); await mkdir(demo, { recursive: true });
    const files = ['building-architecture.ifc', 'building-architecture-rev-b.ifc'].map(n => join(demo, n));
    for (const file of files) await writeFile(file, 'unit input');
    const exclusive = { kind: 'benchmark', state: 'running', startedAt: Date.now() / 1000 };
    await writeFile(originalPath, JSON.stringify(exclusive));
    const bindings = { runtime: await runtimeReceipt(), harnessSource: inventories.base.source,
      measurement: { hostname: hostname() },
      harness: digest(await harnessReceipt()), base: digest(inventories.base), branch: digest(inventories.branch),
      fixtures: { demo: await Promise.all(files.map(p => fileReceipt(p))) } };
    const save = async p => {
      await writeFile(protocolPath, JSON.stringify(p));
      await writeFile(admissionPath, JSON.stringify({ approvedProtocolSha256: (await fileReceipt(protocolPath)).sha256,
        hostname: hostname(), exclusiveReceipt: originalPath, preparation }));
    };
    const args = { protocolPath, admissionPath, baseRoot: root, branchRoot: root, fixtureRoot, out: join(dir, 'output') };
    const runUnit = (args, sampleFn) => run(args, sampleFn, () => inventories.base.source);
    await save(protocol());
    for (const bad of [{ state: 'failed' }, { ...exclusive, state: 'failed' },
      { ...exclusive, kind: 'ordinary' }, { ...exclusive, state: 'queued' },
      { ...exclusive, state: 'completed' }, { ...exclusive, startedAt: null },
      { ...exclusive, startedAt: '2026-10-30' }]) {
      await writeFile(originalPath, JSON.stringify(bad));
      await assert.rejects(runUnit(args, () => assert.fail('invalid admission reached sampling')),
        /exclusive admission receipt/);
    }
    await writeFile(originalPath, JSON.stringify(exclusive));
    await assert.rejects(runUnit(args), /freeze runtime/);
    await save(protocol({ bindings }));
    const calls = [];
    const measured = await runUnit({ ...args, out: join(dir, 'complete-demo') }, async payload => {
      calls.push(payload.mode);
      if (payload.mode === 'proof') await writeFile(payload.resolutionLog, JSON.stringify({ path: runtimePath }) + '\n');
      return { mode: payload.mode, rows: [1, 1], inputHashes: payload.mode === 'proof' ? ['a', 'b'] : undefined,
        proofs: payload.mode === 'proof' ? [{ sha256: 'same' }] : [], log: '',
        phases: { lifecycleTotalMs: 10 }, processWallMs: 11, maxRssKiB: 1,
        retainedTimes: payload.mode === 'warm' ? [1, 1, 9].map(totalMs => ({ totalMs })) : [] };
    });
    assert.deepEqual(calls.slice(0, 2), ['proof', 'proof']);
    assert.ok(calls.slice(2).every(mode => mode !== 'proof'));
    assert.equal(calls.length, 26);
    assert.equal(measured.state, 'incomplete', 'absent real scale coverage cannot pass');
    assert.equal(measured.cases[0].workloads.length, 2);
    assert.equal(measured.cases[0].workloads[1].summary.base.warmProcessMediansMs.n, 6);
    assert.equal(measured.performanceVerdict, 'not-assessed');
    let count = 0;
    await assert.rejects(runUnit({ ...args, out: join(dir, 'mismatch') }, async payload => {
      assert.equal(payload.mode, 'proof'); count++;
      await writeFile(payload.resolutionLog, JSON.stringify({ path: runtimePath }) + '\n');
      return { rows: [1, 1], inputHashes: ['a', 'b'], proofs: [{ sha256: String(count) }], log: '' };
    }), /output\/identity differs/);
    const report = JSON.parse(await readFile(join(dir, 'mismatch/result.json'), 'utf8'));
    assert.equal(count, 2); assert.equal(report.state, 'failed');
    assert.equal(report.performanceVerdict, 'not-assessed');
    assert.equal(report.fullIssue8042Accepted, false);
    assert.equal((await readFile(join(dir, 'mismatch/proofs.jsonl'), 'utf8')).trim().split('\n').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#8042 runtime audit observes actual ESM and transitive CommonJS resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-resolution-unit-'));
  try {
    const entry = join(dir, 'entry.mjs'), esm = join(dir, 'esm.mjs');
    const cjs = join(dir, 'require.cjs'), transitive = join(dir, 'transitive.cjs');
    const log = join(dir, 'resolution.jsonl');
    await writeFile(log, '');
    await writeFile(esm, 'export const value = 7;');
    await writeFile(transitive, 'module.exports = 8;');
    await writeFile(cjs, "module.exports = require('./transitive.cjs');");
    const asset = join(dir, 'asset.wasm'); await writeFile(asset, 'inert wasm asset');
    await writeFile(entry, "import.meta.resolve('./asset.wasm'); import { value } from './esm.mjs'; import cjs from './require.cjs'; if (value + cjs !== 15) throw Error('resolution');");
    execFileSync(process.execPath, ['--experimental-loader', new URL('./diff-e2e-resolve.mjs', import.meta.url).pathname,
      '--require', new URL('./diff-e2e-require.cjs', import.meta.url).pathname, entry],
    { env: { ...process.env, NODE_OPTIONS: '', IFC_DIFF_RESOLUTION_LOG: log }, stdio: 'pipe', timeout: 5000 });
    const paths = new Set((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).path));
    for (const file of [entry, esm, cjs, transitive, asset]) assert.ok(paths.has(file), `missing actual dependency ${file}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#8042 untimed preparation audit discovers dependency paths and preserves skipped coverage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'diff-audit-unit-'));
  try {
    const demo = join(dir, 'apps/viewer/public/samples'); await mkdir(demo, { recursive: true });
    for (const name of ['building-architecture.ifc', 'building-architecture-rev-b.ifc']) await writeFile(join(demo, name), 'inert');
    const dependency = join(dir, 'runtime.mjs'); await writeFile(dependency, 'export {};');
    const out = join(dir, 'audit');
    const modes = [];
    await audit({ p: protocol(), root: dir, implementation: 'typescript', fixtureRoot: dir, out }, async payload => {
      modes.push(payload.mode);
      await writeFile(payload.resolutionLog, JSON.stringify({ path: dependency }) + '\n');
      return { proofs: ['inert behavioral fixture'], log: '' };
    });
    assert.deepEqual(modes, ['proof']);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'runtime-paths.json'), 'utf8')), [dependency]);
    const proofs = JSON.parse(await readFile(join(out, 'proofs.json'), 'utf8'));
    assert.equal(proofs[0].state, 'proof-only');
    // Missing later fixtures must also survive the final audit checkpoint.
    assert.ok(proofs.some(p => p.state === 'skipped'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('#8042 paired intervals enforce margin, uncertainty, spread and minimum rounds independently', () => {
  const base = Array(6).fill(100);
  const passing = endpointVerdict(base, Array(6).fill(105));
  assert.equal(passing.verdict, 'pass');
  assert.deepEqual(passing.ci95, [1.05, 1.05]);
  assert.equal(endpointVerdict(base, Array(6).fill(111)).verdict, 'regression');
  assert.equal(endpointVerdict([100], [99]).verdict, 'dry-run-only');
  const noisy = endpointVerdict([80, 100, 100, 100, 100, 120], [80, 100, 100, 100, 100, 120]);
  assert.equal(noisy.verdict, 'noisy');
  const uncertain = endpointVerdict(base, [100, 100, 100, 115, 115, 115]);
  assert.equal(uncertain.verdict, 'inconclusive');
  assert.deepEqual(uncertain, endpointVerdict(base, [100, 100, 100, 115, 115, 115]));
  assert.equal(cohortVerdict([passing, noisy]), 'noisy');
  assert.equal(cohortVerdict([passing, uncertain]), 'inconclusive');
  assert.equal(cohortVerdict([passing]), 'pass');
});


test('#8042 round CPU utilization is a counter delta, not a process classifier', () => {
  const snapshot = (idle, user) => ({ cpuTimes: [{ idle, user, sys: 0, nice: 0, irq: 0 }] });
  assert.equal(cpuUtilization(snapshot(100, 100), snapshot(175, 125)), 25);
  assert.equal(cpuUtilization(snapshot(100, 100), snapshot(100, 100)), null);
});


test('#8042 planning extrapolates complete pairs and proofs without claiming scale measurements', () => {
  const c = (id, bytes, wall) => ({ id, fixtures: [{ bytes }, { bytes }],
    workloads: [{ pair: { base: { processWallMs: wall }, branch: { processWallMs: wall } } }],
    proof: { base: { processWallMs: wall }, branch: { processWallMs: wall } } });
  const estimate = planningEstimate({ state: 'completed', cases: [c('demo', 1, 1), c('haus', 10, 10)] }, 200);
  assert.equal(estimate.scale, 10);
  assert.equal(estimate.perPairMs, 222);
  assert.equal(estimate.proofMs, 222);
  assert.equal(estimate.fullMs, 1554);
  assert.equal(estimate.timeoutSeconds, 60);
  assert.equal(estimate.withinTwoHourTarget, true);
});
