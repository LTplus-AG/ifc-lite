/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS, FIXTURES, schedule, requireIdentityPair, describeFamily } from './interleaved-plan.mjs';
import { inventory, fileHash } from './interleaved-assets.mjs';
import { serveFrozen } from './interleaved-server.mjs';

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
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      processes.push({ pid: Number(pid), ppid });
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
  return { bytes, processes: descendants.size };
}

function killOwnedGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function oneSample(sample) {
  const path = join(output, `${sample.id}.json`), configPath = join(output, `${sample.id}.input.json`);
  const config = { ...sample, file: provenance.fixtures.find(fixture => fixture.path === sample.path).file,
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
  let refusal;
  const abort = reason => { refusal ??= reason; killOwnedGroup(child); };
  const timer = setTimeout(() => abort('REFUSE: sample wall/identity/teardown deadline'),
    sample.timeoutMs + LIMITS.identityMs + LIMITS.teardownMs + 60_000);
  const monitor = setInterval(() => {
    try {
      const snapshot = { at: Date.now(), ...sampledDescendantRss(child.pid) };
      samples.push(snapshot);
      if (snapshot.bytes > LIMITS.sampledTreeRssBytes) abort('REFUSE: sampled own-tree RSS ceiling');
      if (Date.now() - startedAt > LIMITS.cohortMs) abort('REFUSE: cohort wall ceiling');
    } catch (error) { abort(`REFUSE: RSS monitor unavailable: ${error}`); }
  }, LIMITS.rssIntervalMs);
  let exit;
  try {
    exit = await new Promise((resolveExit, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
  } catch (error) {
    exit = { code: null, signal: null, spawnError: String(error) };
    refusal = `REFUSE: sample could not spawn: ${error}`;
  } finally {
    clearTimeout(timer); clearInterval(monitor); log.end(); killOwnedGroup(child); activeChild = undefined;
  }
  let row;
  try { row = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { row = { ...config, status: 'refused', reason: `No readable child result: ${error}` }; }
  row.exit = exit;
  row.hostAfter = { loadavg: readFileSync('/proc/loadavg', 'utf8').trim() };
  if (refusal || exit.code !== 0 || row.teardown !== 'complete') {
    row.status = 'refused'; row.reason = refusal ?? row.reason ?? 'REFUSE: nonzero child or incomplete teardown';
  }
  if (!samples.length) { row.status = 'refused'; row.reason = 'REFUSE: no own-tree RSS samples'; }
  row.sampledTreeRss = { metric: '250ms aggregate sample descendant RSS; shared pages may be double-counted; not physical peak',
    peakBeforeReadyBytes: row.readyAtMs ? samples.filter(point => point.at <= row.readyAtMs).reduce((max, point) => Math.max(max, point.bytes), 0) : null,
    peakWholeSampleBytes: samples.reduce((max, point) => Math.max(max, point.bytes), 0) };
  writeFileSync(path, JSON.stringify(row, null, 2));
  rss.push({ id: sample.id, samples });
  writeFileSync(join(output, 'rss.json'), JSON.stringify(rss));
  appendFileSync(join(output, 'samples.jsonl'), `${JSON.stringify(row)}\n`);
  return row;
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
    for (const arm of ['base', 'candidate']) {
      if (JSON.stringify(await inventory(join(provenance.builds[arm].dir, 'apps/viewer/dist')))
        !== JSON.stringify(provenance.builds[arm].viewer)) throw new Error('Frozen viewer changed during cohort');
    }
    for (const fixture of provenance.fixtures) if (await fileHash(fixture.file) !== fixture.sha256) throw new Error('Fixture changed during cohort');
    report.finalAssetVerification = 'complete';
  } catch (error) {
    report.status = 'refused'; report.reason = `REFUSE: ${error}`; report.families = {};
    report.finalAssetVerification = 'failed'; process.exitCode = 1;
  }
  for (const [arm, server] of Object.entries(servers)) {
    writeFileSync(join(output, `${arm}.served-assets.json`), JSON.stringify(server.requests, null, 2));
    if (server.requests.some(request => request.status === 500)) {
      report.status = 'refused'; report.reason = 'REFUSE: frozen server fault'; process.exitCode = 1;
    }
    await server.close();
  }
  report.completedSamples = rows.length;
  report.plannedSamples = 48;
  report.elapsedMs = Date.now() - startedAt;
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const lines = [`Same-job viewer comparison: ${report.status}`, '', report.verdict, '',
    `${rows.length}/48 planned samples retained. Failure/refusal is terminal; no replacements.`, report.reason ?? ''];
  for (const fixture of FIXTURES) {
    const family = report.families[fixture.family];
    lines.push('', `${fixture.family}: ${family ? JSON.stringify(family) : 'no complete family comparison'}`);
  }
  writeFileSync(join(output, 'report.md'), lines.join('\n'));
}
