/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { serveFrozen } from './interleaved-server.mjs';
import { finishLog, processIdentity, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { root, output, verifyFrozen } from './sdk-prepare.mjs';
import { schedule, requirePair, limits } from './sdk-plan.mjs';
import { available, quiet, noBuildGraphs, ownedSnapshot } from './sdk-resources.mjs';
import { requireCohortCompletion } from './sdk-completion.mjs';
const provenance = JSON.parse(readFileSync(join(output, 'provenance.json'), 'utf8'));
const report = { status: 'started', scope: 'Hosted Linux default SDK produced CPU channels only', expectedSamples: 56,
  samples: [], pairs: [], families: {}, resourceSamples: [], environment: provenance.environment,
  limitations: 'No full viewer/GPU/pixel/metadata/faithful IFC, native-speed, physical peak or universal speed claim. Complete raw diagnostics retain cache/upper-bound census limitations.' };
const servers = {}, owned = new Map(); let activeChild, activeIdentity, activeAbort, timer, refusal;
const started = Date.now();
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  refusal ??= `received ${signal}`; report.status = 'refused'; report.reason = refusal; process.exitCode = 1;
  if (activeAbort) activeAbort(refusal); else stopActive();
}]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const save = () => {
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(output, 'report.md'), `${report.scope}\n\nStatus: ${report.status}; retained ${report.samples.length}/56 samples.\n\n${report.reason ?? ''}\n\n${report.limitations}\n\n${JSON.stringify(report.families, null, 2)}\n`);
};
function stopActive() {
  if (!activeChild || !activeIdentity) return;
  const current = processIdentity(activeIdentity.pid);
  if (current?.startTime === activeIdentity.startTime && current.pgrp === activeIdentity.pid) {
    try { process.kill(-activeIdentity.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
async function one(sample) {
  const file = provenance.fixtures.find(item => item.family === sample.family).file;
  const build = provenance.builds[sample.arm], inputPath = join(output, `${sample.id}.input.json`), resultPath = join(output, `${sample.id}.json`);
  writeFileSync(inputPath, JSON.stringify({ sample, file, assets: build.assets, origin: servers[sample.arm].origin,
    chromeExecutable: provenance.environment.chromeExecutable, chromeVersion: provenance.environment.chrome }, null, 2));
  const log = createWriteStream(`${resultPath}.runner.log`, { flags: 'wx' }); let timeout, closeTimer, settle, abortCleanup, initialSnapshot, forced = false;
  const child = spawn(process.execPath, [join(root, 'scripts/perf/sdk-sample.mjs'), inputPath, resultPath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child; activeIdentity = processIdentity(child.pid);
  if (activeIdentity) owned.set(`${activeIdentity.pid}:${activeIdentity.startTime}`, activeIdentity);
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const abort = reason => {
    refusal ??= String(reason); stopActive();
    abortCleanup ??= stopWitnessedProcesses([...owned.values()], limits.cleanupMs);
    closeTimer ??= setTimeout(() => { forced = true; child.stdout.destroy(); child.stderr.destroy(); child.unref(); settle?.({ code: null, signal: 'owned-close-deadline' }); }, limits.cleanupMs);
  };
  activeAbort = abort;
  log.on('error', error => abort(`runner log write: ${error}`));
  timeout = setTimeout(() => abort('sample/identity/cleanup wall limit'), sample.timeoutMs + 120000 + limits.cleanupMs + 150000);
  let exit;
  try {
    initialSnapshot = ownedSnapshot(process.pid);
    for (const member of initialSnapshot.members) owned.set(`${member.pid}:${member.startTime}`, member);
    if (!activeIdentity) { child.kill('SIGKILL'); throw new Error('sample PID witness absent'); }
    exit = await new Promise((accept, reject) => { settle = accept; child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  } catch (error) { abort(error); exit = { code: null, reason: String(error) }; }
  finally { clearTimeout(timeout); clearTimeout(closeTimer); stopActive(); activeChild = undefined; activeIdentity = undefined; activeAbort = undefined; }
  const [cleanup, logFlush] = await Promise.all([stopWitnessedProcesses([...owned.values()], limits.cleanupMs), finishLog(log, limits.cleanupMs)]);
  let row;
  try { row = JSON.parse(readFileSync(resultPath, 'utf8')); }
  catch (error) { row = { ...sample, status: 'refused', reason: `missing/unreadable result: ${error}` }; }
  Object.assign(row, { exit, cleanup, logFlush, pipeTailCertified: !forced, initialOwnedSnapshot: initialSnapshot });
  if (abortCleanup) row.abortCleanup = await abortCleanup;
  if (refusal || exit.code !== 0 || row.status !== 'complete' || cleanup.status !== 'complete' || logFlush.status !== 'complete' || forced) {
    row.status = 'refused'; row.reason = refusal ?? row.reason ?? 'child/owned-cleanup/log refusal';
  }
  writeFileSync(resultPath, JSON.stringify(row, null, 2)); report.samples.push(row); save();
  if (row.status !== 'complete') throw new Error(row.reason); return row;
}
save();
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('hosted Linux CI required');
  report.initialResource = { capturedUTC: new Date().toISOString(), availableBytes: available() };
  if (report.initialResource.availableBytes < limits.initialBytes) throw new Error('Linux initial8GiB reserve refused');
  await verifyFrozen(provenance);
  for (const arm of ['base', 'candidate']) servers[arm] = await serveFrozen(provenance.builds[arm].dist, provenance.builds[arm].assets);
  timer = setInterval(() => {
    try {
      const snapshot = ownedSnapshot(process.pid);
      for (const member of snapshot.members) owned.set(`${member.pid}:${member.startTime}`, member);
      if (report.resourceSamples.length >= limits.records) throw new Error('resource record bound');
      const availableBytes = available();
      report.resourceSamples.push({ at: snapshot.at, bytes: snapshot.bytes, availableBytes });
      if (snapshot.bytes > limits.rssBytes || availableBytes < limits.liveBytes) throw new Error('5GiB sampled ownedRSS/4GiB live reserve refused');
      if (Date.now() - started > limits.cohortMs) throw new Error('90-minute cohort wall bound');
      noBuildGraphs();
    } catch (error) { refusal ??= String(error); if (activeAbort) activeAbort(error); else stopActive(); }
  }, 250);
  const plan = schedule();
  for (let index = 0; index < plan.length; index += 2) {
    const pair = { family: plan[index].family, index: plan[index].pair, kind: plan[index].kind, status: 'started' };
    report.pairs.push(pair); save(); await verifyFrozen(provenance);
    await new Promise(accept => setTimeout(accept, limits.drainMs)); pair.beforeCPU = await quiet();
    if (refusal) throw new Error(refusal);
    const left = await one(plan[index]); await new Promise(accept => setTimeout(accept, limits.drainMs));
    if (refusal) throw new Error(refusal);
    const right = await one(plan[index + 1]); await new Promise(accept => setTimeout(accept, limits.drainMs));
    pair.afterCPU = await quiet(); await verifyFrozen(provenance); if (refusal) throw new Error(refusal);
    pair.comparison = requirePair(left, right, report.samples.find(row => row.family === left.family)); pair.status = 'complete';
    const familyPairs = report.pairs.filter(item => item.family === pair.family && item.status === 'complete');
    if (familyPairs.length === 7) report.families[pair.family] = { status: 'complete-14-sample-family', pairedDeltas: familyPairs.filter(item => item.kind === 'AB').map(item => item.comparison.relativeDelta) };
    save();
  }
  if (report.samples.length !== 56) throw new Error('incomplete fixed cohort'); report.status = 'pending-cleanup';
} catch (error) {
  report.status = 'refused'; report.reason = String(error); process.exitCode = 1;
  const incomplete = report.pairs.at(-1);
  if (incomplete?.status === 'started') Object.assign(incomplete, { status: 'refused', reason: report.reason });
}
finally {
  clearInterval(timer); stopActive();
  report.ownedCleanup = await stopWitnessedProcesses([...owned.values()], limits.cleanupMs);
  try { await verifyFrozen(provenance); report.finalInputVerification = 'complete'; }
  catch (error) { report.status = 'refused'; report.reason = String(error); report.finalInputVerification = 'refused'; process.exitCode = 1; }
  save();
  report.serverCleanup = await Promise.all(Object.entries(servers).map(async ([arm, server]) => {
    let receipt;
    try { receipt = await server.close(limits.cleanupMs); }
    catch (error) { receipt = { status: 'refused', reason: String(error) }; }
    writeFileSync(join(output, `${arm}.served-assets.json`), JSON.stringify(server.requests, null, 2));
    return { arm, ...receipt, serverFault: server.requests.some(item => item.status === 500) };
  }));
  try {
    if (refusal || report.status === 'pending-cleanup') requireCohortCompletion(report, refusal);
    if (report.status === 'pending-cleanup') report.status = 'complete-56-sample-hosted-SDK-cohort';
  } catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
  save();
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
