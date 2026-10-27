#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile, rename, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname, cpus, loadavg, freemem, totalmem, platform, release } from 'node:os';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { protocol, validateProtocol, LIMITS, distribution, assertPair, digest, endpointVerdict, cohortVerdict } from './diff-e2e-protocol.mjs';
import { readJson, fileReceipt, inventory, harnessReceipt, validateBuildReceipt, validateResolved, runtimeReceipt, sourceReceipt } from './diff-e2e-receipts.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const environment = () => ({ hostname: hostname(), platform: platform(), release: release(),
  node: process.version, cpu: cpus()[0]?.model, cpuCount: cpus().length,
  totalmem: totalmem(), freemem: freemem(), loadavg: loadavg(),
  timestamp: new Date().toISOString(), cpuTimes: cpus().map(cpu => cpu.times) });

export function sample(payload, timeoutMs = LIMITS.timeoutMs) {
  return new Promise((accept, reject) => {
    const start = performance.now();
    const audit = payload.mode === 'proof' && payload.resolutionLog;
    const child = spawn(process.execPath, [...(audit ? ['--experimental-loader',
      fileURLToPath(new URL('./diff-e2e-resolve.mjs', import.meta.url)), '--require',
      fileURLToPath(new URL('./diff-e2e-require.cjs', import.meta.url))] : []), '--expose-gc', '--max-old-space-size=12288',
      fileURLToPath(new URL('./diff-e2e-sample.mjs', import.meta.url)), JSON.stringify(payload)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', IFC_DIFF_RESOLUTION_LOG: audit || '' } });
    let message, log = '', fault;
    const stop = reason => { fault = reason; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('sample timed out'), timeoutMs);
    const abort = () => stop('cohort interrupted');
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    const collect = chunk => {
      if (Buffer.byteLength(log) + chunk.length > 256 * 1024) stop('sample log exceeded 256 KiB');
      else log += chunk.toString();
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('message', value => {
      if (message) stop('duplicate sample IPC response');
      message = value;
    });
    child.on('error', error => { fault = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
      if (fault || code !== 0 || !message?.sample || message.error) {
        const error = new Error(fault ?? message?.error ?? `sample exited ${code}/${signal}`);
        error.log = log;
        reject(error);
      } else accept({ ...message.sample, processWallMs: performance.now() - start, log });
    });
  });
}

export function summary(pairs) {
  const result = { inferenceUnit: 'paired fresh process; repetitions are correlated' };
  for (const arm of ['base', 'branch']) {
    const samples = pairs.map(pair => pair[arm]);
    result[arm] = {
      phases: Object.fromEntries(Object.keys(samples[0].phases).map(key =>
        [key, distribution(samples.map(s => s.phases[key]))])),
      processWallMs: distribution(samples.map(s => s.processWallMs)),
      maxRssKiB: distribution(samples.map(s => s.maxRssKiB)),
      // Exactly one summary per process. Never flatten repeats into n=pairs*repeats.
      warmProcessMediansMs: samples[0].retainedTimes.length ? distribution(samples.map(s =>
        distribution(s.retainedTimes.map(t => t.totalMs)).median)) : undefined,
    };
  }
  for (const [name, endpoint] of [['Lifecycle', s => s.phases.lifecycleTotalMs],
    ...(pairs[0].base.retainedTimes.length ? [['WarmCall', s => distribution(s.retainedTimes.map(t => t.totalMs)).median]] : [])]) {
    const deltas = pairs.map(p => endpoint(p.branch) - endpoint(p.base));
    result[`paired${name}DeltaMs`] = distributionSigned(deltas);
    result[`paired${name}Ratio`] = distribution(pairs.map(p => {
      assert.ok(endpoint(p.base) > 0, 'zero endpoint cannot support a ratio');
      return endpoint(p.branch) / endpoint(p.base);
    }));
  }
  return result;
}

function distributionSigned(values) {
  const offset = Math.min(0, ...values);
  const d = distribution(values.map(v => v - offset));
  return { ...d, min: d.min + offset, median: d.median + offset,
    p95: d.p95 + offset, max: d.max + offset, samples: values };
}

export async function run({ protocolPath, admissionPath, baseRoot, branchRoot, fixtureRoot, out }, sampleFn = sample, harnessSourceFn = () => sourceReceipt(fileURLToPath(new URL('../../', import.meta.url)))) {
  const { value: p, receipt: protocolFile } = await readJson(protocolPath);
  validateProtocol(p);
  const { value: admission, receipt: admissionFile } = await readJson(admissionPath);
  assert.equal(admission.approvedProtocolSha256, protocolFile.sha256, 'parent must review this exact protocol');
  assert.equal(admission.hostname, hostname(), 'admission is for a different host');
  const exclusive = await fileReceipt(admission.exclusiveReceipt);
  const builds = {};
  for (const [arm, root, implementation] of [['base', baseRoot, 'typescript'], ['branch', branchRoot, 'rust-wasm']]) {
    const prep = admission.preparation[arm];
    const { value: prepared, receipt } = await readJson(prep.inventory, 32 * 1024 * 1024);
    const { value: build } = await readJson(prep.receipt, 32 * 1024 * 1024);
    const { value: execution, receipt: original } = await readJson(build.originalReceipt.path, 32 * 1024 * 1024);
    const { value: manifest, receipt: manifestReceipt } = await readJson(build.outputManifestReceipt.path, 32 * 1024 * 1024);
    const actual = await inventory(root, implementation, Object.keys(prepared.dependencies));
    validateBuildReceipt(build, actual, original, execution, manifest, manifestReceipt);
    assert.deepEqual(actual, prepared, `${arm}: build bytes/source differ from preparation inventory`);
    builds[arm] = { inventory: actual, inventoryReceipt: receipt,
      preparationReceipt: await fileReceipt(prep.receipt) };
    const delta = relative(actual.root, resolve(out));
    assert.ok(isAbsolute(delta) || delta === '..' || delta.startsWith('../'), '--out must be outside both source roots');
  }
  // No file overwrite or uncertain-outcome restart; retain the original out.
  const harness = await harnessReceipt();
  assert.ok(p.bindings, 'freeze runtime/source/harness/fixture bindings before approval');
  const harnessSource = harnessSourceFn();
  assert.deepEqual(p.bindings.harnessSource, harnessSource, 'harness source identity mismatch');
  assert.equal(p.bindings.measurement.hostname, hostname());
  assert.deepEqual(p.bindings.runtime, await runtimeReceipt());
  assert.equal(p.bindings.harness, digest(harness));
  for (const arm of ['base', 'branch']) assert.equal(p.bindings[arm], digest(builds[arm].inventory));
  await mkdir(out, { recursive: false });
  const report = { version: p.version, state: 'running', performanceVerdict: 'not-assessed',
    fullIssue8042Accepted: false, protocol: p, protocolFile, admissionFile, exclusive,
    coverage: { adapter: 'final public facade; per-call handles', fingerprintEngine: 'public API on each source; Rust pipeline acceptance still required',
      geometry: 'absent from real CLI projection', auxiliaryOperations: 'not timed; separate parity evidence required' },
    harness, harnessSource, builds: {}, environment: environment(), cases: [],
    startedAt: new Date().toISOString() };
  for (const arm of ['base', 'branch']) {
    const build = builds[arm];
    const path = resolve(out, `${arm}.inventory.json`);
    await writeFile(path, JSON.stringify(build.inventory, null, 2) + '\n', { flag: 'wx' });
    report.builds[arm] = { source: build.inventory.source, inventory: await fileReceipt(path),
      preparedInventory: build.inventoryReceipt, preparationReceipt: build.preparationReceipt };
  }
  const persist = async () => {
    await writeFile(resolve(out, 'result.pending.json'), JSON.stringify(report, null, 2) + '\n');
    await rename(resolve(out, 'result.pending.json'), resolve(out, 'result.json'));
  };
  await persist();
  try {
    for (const definition of p.cases) {
      const fixture = { ...definition, paths: definition.paths.map(path => resolve(fixtureRoot, path)) };
      const entry = { id: fixture.id, kind: fixture.kind, state: 'running' };
      report.cases.push(entry);
      if (!fixture.paths.length) {
        Object.assign(entry, { state: 'skipped', reason: 'large real revision pair not configured; supply --large-base and --large-head' });
        await persist(); continue;
      }
      try { entry.fixtures = await Promise.all(fixture.paths.map(path => fileReceipt(path))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        Object.assign(entry, { state: 'skipped', reason: 'missing fixture; run pnpm fixtures (demo files must exist in source)' });
        await persist(); continue;
      }
      assert.deepEqual(entry.fixtures, p.bindings.fixtures[fixture.id], 'fixture identity not frozen');
      if (fixture.headSha256) assert.equal(entry.fixtures[1].sha256, fixture.headSha256, 'frozen large head differs');
      // All proof executions for this fixture precede its timing. They run in their own processes;
      // their traversals/hashes never interleave with measured comparisons.
      entry.proof = {};
      for (const arm of ['base', 'branch']) {
        const resolutionLog = resolve(out, `${fixture.id}-${arm}.resolution.jsonl`);
        await writeFile(resolutionLog, '', { flag: 'wx' });
        const observation = await sampleFn({ root: builds[arm].inventory.root, fixture,
          options: p.options, retained: p.retained, mode: 'proof', resolutionLog,
          implementation: arm === 'base' ? 'typescript' : 'rust-wasm' });
        entry.proof[arm] = observation;
        await appendFile(resolve(out, 'proofs.jsonl'), JSON.stringify({ fixture: fixture.id, arm, ...observation }) + '\n');
        await fileReceipt(resolutionLog, 32 * 1024 * 1024);
        const resolutions = (await readFile(resolutionLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        await validateResolved(resolutions.map(r => r.path), builds[arm].inventory, report.harness);
      }
      assertPair(entry.proof.base, entry.proof.branch);
      entry.workloads = [];
      // Fixed option order is declared in protocol; each option/mode gets its
      // own fresh process pairs, so no prior option warms a cold endpoint.
      for (const mode of ['cold', 'warm']) for (let optionIndex = 0; optionIndex < p.options.length; optionIndex++) {
        const workload = { mode, optionIndex, pairs: [] };
        entry.workloads.push(workload);
        for (let round = 0; round < p.pairs; round++) {
          const pair = { round, order: p.order[round], before: environment() };
          for (const arm of pair.order) {
            const observation = await sampleFn({ root: builds[arm].inventory.root, fixture,
              options: p.options, retained: p.retained, mode, optionIndex,
              implementation: arm === 'base' ? 'typescript' : 'rust-wasm' });
            await appendFile(resolve(out, 'samples.jsonl'), JSON.stringify({ fixture: fixture.id, round, arm, ...observation }) + '\n');
            const { log, ...compact } = observation;
            await appendFile(resolve(out, 'samples.log'), `[${fixture.id} ${mode} ${optionIndex} ${round} ${arm}]\n${log}\n`);
            pair[arm] = compact;
          }
          pair.after = environment();
          workload.pairs.push(pair);
          await persist();
          assert.deepEqual(pair.base.rows, entry.proof.base.rows);
          assert.deepEqual(pair.branch.rows, entry.proof.branch.rows);
        }
        workload.summary = summary(workload.pairs);
        const endpoint = s => mode === 'cold' ? s.phases.lifecycleTotalMs
          : distribution(s.retainedTimes.map(t => t.totalMs)).median;
        workload.timing = endpointVerdict(workload.pairs.map(p => endpoint(p.base)),
          workload.pairs.map(p => endpoint(p.branch)));
      }
      assert.deepEqual(await Promise.all(fixture.paths.map(path => fileReceipt(path))), entry.fixtures, 'fixture mutated');
      entry.state = 'measured-separate-proof-identical';
      await persist();
    }
    for (const arm of ['base', 'branch']) {
      const inv = builds[arm].inventory;
      assert.deepEqual(await inventory(inv.root, inv.implementation, Object.keys(inv.dependencies)), inv, 'source or binary changed during cohort');
    }
    assert.deepEqual(await harnessReceipt(), report.harness, 'harness changed during cohort');
    assert.deepEqual(harnessSourceFn(), report.harnessSource, 'harness source changed during cohort');
    assert.deepEqual(await runtimeReceipt(), p.bindings.runtime, 'runtime changed during cohort');
    report.state = report.cases.some(c => c.state === 'skipped') ? 'incomplete' : 'measured';
    if (report.state === 'measured' && !p.dryRun) report.performanceVerdict = cohortVerdict(
      report.cases.flatMap(c => c.workloads.map(w => w.timing)));
    if (p.dryRun) report.performanceVerdict = 'dry-run-only';
  } catch (error) {
    report.state = 'failed'; report.error = error.stack ?? String(error);
    if (error.log) await appendFile(resolve(out, 'samples.log'), error.log);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString(); report.environmentAfter = environment();
    await persist();
  }
  return report;
}

// Untimed preparation only, under the parent's ordinary admitted preparation.
// Discovers real runtime dependencies before building the frozen inventory.
export async function audit({ p, root, implementation, fixtureRoot, out }, sampleFn = sample) {
  validateProtocol(p);
  await mkdir(out, { recursive: false });
  const harnessPaths = new Set(Object.values(await harnessReceipt()).map(r => r.path));
  const paths = new Set(), results = [];
  for (const definition of p.cases) {
    if (!definition.paths.length) { results.push({ id: definition.id, state: 'skipped' }); continue; }
    const fixture = { ...definition, paths: definition.paths.map(path => resolve(fixtureRoot, path)) };
    try { await Promise.all(fixture.paths.map(path => fileReceipt(path))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      results.push({ id: fixture.id, state: 'skipped', reason: 'missing fixture; run pnpm fixtures' }); continue;
    }
    const resolutionLog = resolve(out, `${fixture.id}.resolution.jsonl`);
    await writeFile(resolutionLog, '', { flag: 'wx' });
    const observation = await sampleFn({ root, implementation, fixture, options: p.options,
      retained: p.retained, mode: 'proof', resolutionLog });
    await fileReceipt(resolutionLog, 32 * 1024 * 1024);
    for (const line of (await readFile(resolutionLog, 'utf8')).trim().split('\n')) {
      const { path } = JSON.parse(line);
      if (!harnessPaths.has(path)) paths.add(path);
      assert.ok(paths.size <= 30_000, 'runtime dependency bound');
    }
    results.push({ id: fixture.id, state: 'proof-only', ...observation });
    await writeFile(resolve(out, 'proofs.json'), JSON.stringify(results, null, 2) + '\n');
  }
  await writeFile(resolve(out, 'proofs.json'), JSON.stringify(results, null, 2) + '\n');
  assert.ok(paths.size, 'no actual runtime paths; prepare fixtures and final facade');
  await writeFile(resolve(out, 'runtime-paths.json'), JSON.stringify([...paths].sort(), null, 2) + '\n', { flag: 'wx' });
}

// Ordinary admitted smoke only. No preparation/admission attestation is invented;
// this exercises real child IPC, parsing, public engines and identity, but cannot
// issue a performance verdict or replace the source-pinned exclusive cohort.
export async function dryRun({ baseRoot, branchRoot, fixtureRoot, out }, sampleFn = sample) {
  const p = protocol({ pairs: 1, dryRun: true });
  await mkdir(out, { recursive: false });
  const start = performance.now();
  const report = { state: 'running', performanceVerdict: 'dry-run-only',
    fullIssue8042Accepted: false, protocol: p, environment: environment(), cases: [] };
  try {
    for (const definition of p.cases) {
      const fixture = { ...definition, paths: definition.paths.map(path => resolve(fixtureRoot, path)) };
      const entry = { id: fixture.id, fixtures: await Promise.all(fixture.paths.map(path => fileReceipt(path))), proof: {}, workloads: [] };
      report.cases.push(entry);
      const payload = arm => ({ root: arm === 'base' ? baseRoot : branchRoot, fixture,
        options: p.options, retained: p.retained, implementation: arm === 'base' ? 'typescript' : 'rust-wasm' });
      for (const arm of p.order[0]) entry.proof[arm] = await sampleFn({ ...payload(arm), mode: 'proof' });
      assertPair(entry.proof.base, entry.proof.branch);
      for (const mode of ['cold', 'warm']) {
        const pair = { order: p.order[0], before: environment() };
        for (const arm of pair.order) pair[arm] = await sampleFn({ ...payload(arm), mode });
        pair.after = environment();
        entry.workloads.push({ mode, pair, summary: summary([pair]) });
      }
    }
    report.state = 'completed';
  } catch (error) {
    report.state = 'failed'; report.error = error.stack ?? String(error);
    throw error;
  } finally {
    report.wallMs = performance.now() - start;
    report.pairWallMs = report.cases.reduce((sum, c) => sum + c.workloads.reduce((n, w) =>
      n + w.pair.base.processWallMs + w.pair.branch.processWallMs, 0), 0);
    await writeFile(resolve(out, 'dry-run.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ state: report.state, wallMs: report.wallMs, pairWallMs: report.pairWallMs,
      result: resolve(out, 'dry-run.json') }));
  }
  return report;
}

export async function main(args) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options:
    Object.fromEntries(['protocol', 'admission', 'base-root', 'branch-root', 'fixture-root', 'out',
      'pairs', 'seed', 'dry-run', 'retained', 'large-base', 'large-head', 'root', 'implementation', 'bindings', 'runtime-paths']
      .map(key => [key, { type: 'string' }])) });
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok((major === 22 && minor >= 13) || major === 24, 'use supported Node >=22.13 (22.x or 24.x)');
  assert.equal(positionals.length, 1, 'choose plan, audit, inventory or run; see diff-e2e.md');
  assert.ok(v.out, '--out is required (outside source checkout)');
  if (positionals[0] === 'dry-run') {
    for (const key of ['base-root', 'branch-root', 'fixture-root']) assert.ok(v[key], `--${key} required`);
    await dryRun({ baseRoot: resolve(v['base-root']), branchRoot: resolve(v['branch-root']),
      fixtureRoot: resolve(v['fixture-root']), out: resolve(v.out) });
  } else if (positionals[0] === 'plan') {
    const p = protocol({ pairs: Number(v.pairs ?? (v['dry-run'] === 'true' ? 1 : 6)), seed: Number(v.seed ?? 8042),
      dryRun: v['dry-run'] === 'true', retained: Number(v.retained ?? 3),
      largeBase: v['large-base'], largeHead: v['large-head'],
      bindings: v.bindings ? (await readJson(v.bindings, 32 * 1024 * 1024)).value : undefined });
    await writeFile(v.out, JSON.stringify(p, null, 2) + '\n', { flag: 'wx' });
  } else if (positionals[0] === 'audit') {
    for (const key of ['protocol', 'root', 'implementation', 'fixture-root']) assert.ok(v[key], `--${key} required`);
    assert.ok(['typescript', 'rust-wasm'].includes(v.implementation));
    await audit({ p: (await readJson(v.protocol, 32 * 1024 * 1024)).value,
      root: resolve(v.root), implementation: v.implementation, fixtureRoot: resolve(v['fixture-root']), out: resolve(v.out) });
  } else if (positionals[0] === 'inventory') {
    assert.ok(['typescript', 'rust-wasm'].includes(v.implementation));
    const result = await inventory(v.root, v.implementation, (await readJson(v['runtime-paths'])).value);
    await writeFile(v.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  } else {
    assert.equal(positionals[0], 'run');
    for (const key of ['protocol', 'admission', 'base-root', 'branch-root', 'fixture-root']) assert.ok(v[key], `--${key} required`);
    const report = await run({ protocolPath: v.protocol, admissionPath: v.admission,
      baseRoot: v['base-root'], branchRoot: v['branch-root'], fixtureRoot: v['fixture-root'], out: resolve(v.out) });
    console.log(JSON.stringify({ state: report.state, performanceVerdict: report.performanceVerdict,
      cases: report.cases.map(c => ({ id: c.id, state: c.state })), result: resolve(v.out, 'result.json') }));
    if (report.state !== 'measured') process.exitCode = 2;
  }
}

if (isMainEntry(import.meta.url)) {
  await main(process.argv.slice(2));
}
