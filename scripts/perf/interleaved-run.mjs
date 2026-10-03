/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS, FIXTURES, GRAPHICS_PROFILE, schedule, requireIdentityPair, describeFamily } from './interleaved-plan.mjs';
import { inventory, fileHash } from './interleaved-assets.mjs';
import { serveFrozen } from './interleaved-server.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'interleaved-results');
const provenance = JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'));
const servers = {}, rows = [], rss = [];
const startedAt = Date.now();
let activeChild;
const report = { status: 'started', environment: provenance.runtime, families: {},
  verdict: 'Descriptive same-job CPU worker-pool/full-readiness evidence only; native GPU/FPS benefit unclaimed.' };

// /proc inspection of THIS spawned sample's descendant tree only. Aggregate RSS
// double-counts shared pages and is sampled: it is not physical-memory peak.
function sampledDescendantRss(rootPid) {
  const processes = [];
  for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try {
      const identity = processIdentity(pid);
      if (identity) processes.push(identity);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  const descendants = new Set([rootPid]);
  for (let iteration = 0; iteration < 32; iteration++) {
    const prior = descendants.size;
    for (const process of processes) if (descendants.has(process.ppid)) descendants.add(process.pid);
    if (descendants.size === prior) break;
    if (iteration === 31) throw new Error('REFUSE: sample process tree depth bound');
  }
  let bytes = 0;
  for (const pid of descendants) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+) kB$/m);
      if (match) bytes += Number(match[1]) * 1024;
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
  }
  return { bytes, processes: descendants.size, members: processes.filter(member => descendants.has(member.pid)) };
}

function killOwnedGroup(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function oneSample(sample) {
  const path = join(output, `${sample.id}.json`), configPath = join(output, `${sample.id}.input.json`);
  const config = { ...sample, graphics: GRAPHICS_PROFILE, file: provenance.fixtures.find(fixture => fixture.path === sample.path).file,
    origin: servers[sample.arm].origin, revision: provenance.builds[sample.arm].revision,
    defaultWasmPaths: provenance.builds[sample.arm].viewer.filter(asset => asset.sha256 === provenance.builds[sample.arm].wasmSha256).map(asset => `/${asset.path}`),
    hostBefore: { loadavg: readFileSync('/proc/loadavg', 'utf8').trim() } };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const log = createWriteStream(`${path}.runner.log`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VIEWER_BENCHMARK_')) throw new Error(`REFUSE: benchmark override ${key}`);
  const child = spawn('pnpm', ['exec', 'tsx', 'scripts/perf/interleaved-sample.ts', configPath, path],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const samples = [];
  const owned = new Map();
  const rootIdentity = child.pid && processIdentity(child.pid);
  if (rootIdentity) owned.set(rootIdentity.pid, rootIdentity);
  let refusal;
  let logFlush, cleanup;
  let settleExit, exitDeadline, abortCleanup, forcedExit = false;
  log.on('error', error => { refusal ??= `REFUSE: runner log write failed: ${error}`; killOwnedGroup(child); });
  const abort = reason => {
    refusal ??= reason; killOwnedGroup(child);
    abortCleanup ??= stopWitnessedProcesses([...owned.values()], LIMITS.teardownMs)
      .catch(error => ({ status: 'refused', reason: String(error) }));
    exitDeadline ??= setTimeout(() => {
      forcedExit = true;
      // Own pipes only. A refusal explicitly records that an unreachable tail
      // could not be certified lossless; never turn this into a complete row.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      settleExit?.({ code: null, signal: 'owned-close-deadline' });
    }, LIMITS.teardownMs);
  };
  const timer = setTimeout(() => abort('REFUSE: sample wall/identity/teardown deadline'),
    sample.timeoutMs + LIMITS.identityMs + LIMITS.teardownMs + 60_000);
  const monitor = setInterval(() => {
    try {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const snapshot = { at: Date.now(), ...sampledDescendantRss(child.pid) };
      for (const member of snapshot.members) owned.set(member.pid, member);
      samples.push(snapshot);
      if (snapshot.bytes > LIMITS.sampledTreeRssBytes) abort('REFUSE: sampled own-tree RSS ceiling');
      if (Date.now() - startedAt > LIMITS.cohortMs) abort('REFUSE: cohort wall ceiling');
    } catch (error) { abort(`REFUSE: RSS monitor unavailable: ${error}`); }
  }, LIMITS.rssIntervalMs);
  let exit;
  try {
    exit = await new Promise((resolveExit, reject) => {
      settleExit = resolveExit;
      child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
  } catch (error) {
    exit = { code: null, signal: null, spawnError: String(error) };
    refusal = `REFUSE: sample could not spawn: ${error}`;
  } finally {
    clearTimeout(timer); clearTimeout(exitDeadline); clearInterval(monitor); killOwnedGroup(child); activeChild = undefined;
    // One shared 30s cleanup budget; report the actual flush and PID-fenced drain.
    const deadline = Date.now() + LIMITS.teardownMs;
    [cleanup, logFlush] = await Promise.all([
      stopWitnessedProcesses([...owned.values()], Math.max(1, deadline - Date.now()))
        .catch(error => ({ status: 'refused', reason: String(error) })),
      finishLog(log, Math.max(1, deadline - Date.now())),
    ]);
    if (abortCleanup) {
      const aborted = await abortCleanup;
      if (aborted.status !== 'complete') cleanup = aborted;
    }
    if (forcedExit) logFlush = { status: 'refused', reason: 'Owned-close deadline; captured log flushed, unreachable tail uncertified' };
  }
  let row;
  try { row = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { row = { ...config, status: 'refused', reason: `No readable child result: ${error}` }; }
  row.exit = exit;
  row.ownedCleanup = cleanup; row.runnerLogFlush = logFlush;
  row.hostAfter = { loadavg: readFileSync('/proc/loadavg', 'utf8').trim() };
  if (refusal || exit.code !== 0 || row.teardown !== 'complete') {
    row.status = 'refused'; row.reason = refusal ?? row.reason ?? 'REFUSE: nonzero child or incomplete teardown';
  }
  if (!samples.length) { row.status = 'refused'; row.reason = 'REFUSE: no own-tree RSS samples'; }
  if (cleanup.status !== 'complete' || logFlush.status !== 'complete') {
    row.status = 'refused'; row.reason = 'REFUSE: incomplete owned cleanup or runner log flush';
  }
  row.sampledTreeRss = { metric: '250ms aggregate sample descendant RSS; shared pages may be double-counted; not physical peak',
    peakBeforeReadyBytes: row.readyAtMs ? samples.filter(point => point.at <= row.readyAtMs).reduce((max, point) => Math.max(max, point.bytes), 0) : null,
    peakWholeSampleBytes: samples.reduce((max, point) => Math.max(max, point.bytes), 0) };
  writeFileSync(path, JSON.stringify(row, null, 2));
  rss.push({ id: sample.id, samples });
  writeFileSync(join(output, 'rss.json'), JSON.stringify(rss));
  appendFileSync(join(output, 'samples.jsonl'), `${JSON.stringify(row)}\n`);
  return row;
}

function persistReport() {
  report.completedSamples = rows.length; report.plannedSamples = 48; report.elapsedMs = Date.now() - startedAt;
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [`Same-job viewer comparison: ${report.status}`, '', report.verdict, '',
    `${rows.length}/48 planned samples retained. Failure/refusal is terminal; no replacements.`, report.reason ?? ''];
  for (const fixture of FIXTURES) {
    const family = report.families[fixture.family];
    lines.push('', `${fixture.family}: ${family ? JSON.stringify(family) : 'no complete family comparison'}`);
  }
  writeFileSync(join(output, 'report.md'), lines.join('\n'));
}

async function verifyFrozenInputs() {
  for (const arm of ['base', 'candidate']) {
    if (JSON.stringify(await inventory(join(provenance.builds[arm].dir, 'apps/viewer/dist')))
      !== JSON.stringify(provenance.builds[arm].viewer)) throw new Error('Frozen viewer changed during cohort');
  }
  for (const fixture of provenance.fixtures) if (await fileHash(fixture.file) !== fixture.sha256) throw new Error('Fixture changed during cohort');
}

try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('REFUSE: intended same-job Linux CI environment required');
  for (const arm of ['base', 'candidate']) {
    const build = provenance.builds[arm], dir = join(build.dir, 'apps/viewer/dist');
    if (JSON.stringify(await inventory(dir)) !== JSON.stringify(build.viewer)) throw new Error('REFUSE: frozen viewer changed before cohort');
    servers[arm] = await serveFrozen(dir, build.viewer);
  }
  writeFileSync(join(output, 'schedule.json'), JSON.stringify(schedule(), null, 2));
  for (const sample of schedule()) {
    if (Date.now() - startedAt > LIMITS.cohortMs) throw new Error('REFUSE: cohort wall ceiling');
    const row = await oneSample(sample);
    rows.push(row);
    if (row.status !== 'complete') throw new Error(row.reason ?? 'REFUSE: sample incomplete');
    if (rows.length % 2 === 0) requireIdentityPair(rows.at(-2), row);
    const familyRows = rows.filter(item => item.family === sample.family);
    if (familyRows.length === 12) report.families[sample.family] = describeFamily(familyRows);
  }
  if (rows.length !== 48) throw new Error('REFUSE: incomplete fixed cohort');
  report.status = 'complete';
} catch (error) {
  report.status = 'refused'; report.reason = String(error); process.exitCode = 1;
} finally {
  killOwnedGroup(activeChild);
  try {
    await verifyFrozenInputs();
    report.finalAssetVerification = 'complete';
  } catch (error) {
    report.status = 'refused'; report.reason = `REFUSE: ${error}`; report.families = {};
    report.finalAssetVerification = 'failed'; process.exitCode = 1;
  }
  report.serverCleanup = 'pending';
  if (report.status === 'complete') report.status = 'pending-server-cleanup';
  persistReport(); // Terminal measurement result exists BEFORE any server close.
  const receipts = await Promise.allSettled(Object.entries(servers).map(async ([arm, server]) => {
    writeFileSync(join(output, `${arm}.served-assets.json`), JSON.stringify(server.requests, null, 2));
    if (server.requests.some(request => request.status === 500)) {
      report.status = 'refused'; report.reason = 'REFUSE: frozen server fault'; process.exitCode = 1;
    }
    return { arm, ...await server.close(LIMITS.teardownMs) };
  }));
  report.serverCleanup = receipts.map(receipt => receipt.status === 'rejected'
    ? { status: 'rejected', reason: String(receipt.reason) } : receipt);
  if (receipts.some(receipt => receipt.status !== 'fulfilled' || receipt.value.status !== 'complete')) {
    report.status = 'refused'; report.reason = 'REFUSE: incomplete bounded owned server cleanup'; process.exitCode = 1;
  } else if (report.status === 'pending-server-cleanup') report.status = 'complete';
  persistReport();
}
