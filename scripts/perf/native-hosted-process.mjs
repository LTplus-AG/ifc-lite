/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { createWriteStream, readdirSync, readlinkSync } from 'node:fs';
import { fileHash } from './interleaved-assets.mjs';
import { processIdentity, finishLog, stopWitnessedProcesses } from './interleaved-cleanup.mjs';
import { available, ownedSnapshot, processObservation, noBuildGraphs } from './sdk-resources.mjs';
import { cargoArgs, freshnessException, freshnessPredicates, refreshedCargoWitness, cargoWitnessRefreshPredicates, limits } from './native-hosted-plan.mjs';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';
import { withPinnedNativeExecutables, hashPinnedNativeExecutable, versionPostOpenBindings, rustcReadOnlyQueryKind, versionProbeAdmission, versionProbePredicates } from './native-version-probe.mjs';
export function compilerEnvironment(environment, tools) {
  if (!tools) return environment;
  if (![tools.cargo, tools.rustc, tools.rustdoc].every(path => typeof path === 'string' && isAbsolute(path))
    || dirname(tools.cargo) !== dirname(tools.rustc) || dirname(tools.cargo) !== dirname(tools.rustdoc)
    || basename(dirname(dirname(tools.rustc))) !== tools.toolchain
    || typeof tools.toolchain !== 'string' || !/^nightly-\d{4}-\d{2}-\d{2}-[a-z0-9_-]+$/.test(tools.toolchain)) {
    throw new Error('native compiler selection refused');
  }
  return { ...environment, RUSTC: tools.rustc, RUSTDOC: tools.rustdoc, RUSTUP_TOOLCHAIN: tools.toolchain };
}
function nativeRecord(name, identity, observed) {
  const record = { ...identity, ...observed, cwd: readlinkSync(`/proc/${name}/cwd`) };
  if (observed.executableObserved) {
    try { record.executableFileIdentity = nativeFileIdentity(`/proc/${name}/exe`); }
    catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
      record.executableFileIdentityError = error.code;
    }
  }
  return record;
}
function liveRecord(pid) {
  const observed = processObservation(pid), identity = processIdentity(pid);
  return observed && identity ? nativeRecord(pid, identity, observed) : null;
}
function versionProof(record, witnesses, admittedCargo, expected, proof) {
  proof.captureStartedAt = Date.now();
  proof.admittedParent = admittedCargo.get(record.ppid); proof.parentWitness = witnesses.get(record.ppid);
  proof.snapshot = ownedSnapshot(process.pid);
  proof.currentParent = liveRecord(record.ppid); proof.currentChild = liveRecord(record.pid);
  const parent = proof.currentParent, child = proof.currentChild;
  const parentTool = parent?.executable === expected.cargo ? 'cargo' : parent?.executable === expected.rustup ? 'rustup' : null;
  if (rustcReadOnlyQueryKind(child, expected) && sameNativeFile(child.executableFileIdentity, expected.rustcFileIdentity)
    && parentTool && freshnessException(parent, proof.parentWitness, expected)
    && sameNativeFile(parent.executableFileIdentity, expected[`${parentTool}FileIdentity`])) {
    withPinnedNativeExecutables([
      { path: `/proc/${child.pid}/exe`, fileIdentity: expected.rustcFileIdentity, bytes: expected.rustcFileBytes },
      { path: `/proc/${parent.pid}/exe`, fileIdentity: expected[`${parentTool}FileIdentity`], bytes: expected[`${parentTool}FileBytes`] },
    ], ([childPin, parentPin]) => {
      proof.pinsOpenedAt = Date.now();
      proof.pinnedChild = { fileIdentity: childPin.fileIdentity, bytes: childPin.bytes };
      proof.pinnedParent = { fileIdentity: parentPin.fileIdentity, bytes: parentPin.bytes };
      proof.postOpenChild = liveRecord(record.pid); proof.postOpenParent = liveRecord(record.ppid);
      proof.postOpenObservedAt = Date.now();
      if (!versionPostOpenBindings(record, expected, proof)) throw new Error('live process binding after both FD opens refused');
      proof.pinnedChild = hashPinnedNativeExecutable(childPin);
      proof.pinnedParent = hashPinnedNativeExecutable(parentPin);
      proof.finalParent = liveRecord(record.ppid);
      const before = processIdentity(record.pid);
      proof.finalChild = before ? liveRecord(record.pid) : null;
      proof.finalChildStat = { observed: true, before, after: processIdentity(record.pid) };
    });
  }
  proof.captureCompletedAt = Date.now();
  return proof;
}
function graphScan(witnesses, admittedCargo, expected) {
  const exceptions = [], permissionFallbacks = [], witnessRefreshes = [], versionCandidates = [], versionProbeExceptions = []; let freshSnapshot;
  for (const name of readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const observed = processObservation(name); if (!observed) continue;
      const { classification } = observed;
      if (!observed.executableObserved) permissionFallbacks.push({ pid: observed.pid, executableObserved: false, executableAccessError: observed.executableAccessError });
      if (!classification) continue;
      const identity = processIdentity(name); if (!identity) continue;
      const record = nativeRecord(name, identity, observed);
      // Defer only this exact candidate until Cargo parents in the same scan
      // have been admitted by the unchanged freshness ownership predicates.
      if (rustcReadOnlyQueryKind(record, expected)) {
        if (versionCandidates.length >= 4096) throw new Error('native read-only query candidate evidence bound');
        versionCandidates.push(record); continue;
      }
      let refreshAttempt;
      if (!witnesses.has(record.pid) && freshnessException(record, record, expected)) {
        freshSnapshot ??= ownedSnapshot(process.pid); // At most one bounded fresh own-ancestry census per scan.
        const currentObserved = processObservation(name), currentIdentity = processIdentity(name);
        const current = currentObserved && currentIdentity ? nativeRecord(name, currentIdentity, currentObserved) : null;
        refreshAttempt = { capturedAt: freshSnapshot.at, censusMembers: freshSnapshot.members.length,
          ancestryMember: freshSnapshot.members.find(item => item.pid === record.pid) ?? null,
          current, predicates: cargoWitnessRefreshPredicates(record, expected, freshSnapshot, current) };
        const refreshed = refreshedCargoWitness(record, expected, freshSnapshot, current);
        if (refreshed) {
          witnesses.set(refreshed.pid, refreshed);
          witnessRefreshes.push({ ...refreshed, source: 'fresh-own-ancestry-census-plus-current-observation', capturedAt: freshSnapshot.at,
            censusMembers: freshSnapshot.members.length, depthBound: 32, processBound: 4096, refreshAttempt });
        }
      }
      const witness = witnesses.get(record.pid);
      if (!freshnessException(record, witness, expected)) {
        const details = { actual: record, expected: { ...expected, argv: ['cargo', ...cargoArgs] },
          witness: witness ?? null, refreshAttempt: refreshAttempt ?? null, predicates: freshnessPredicates(record, witness, expected) };
        const error = new Error(`non-exempt compiler/test graph: ${JSON.stringify(details)}`);
        error.freshnessRefusal = details;
        throw error;
      }
      exceptions.push({ ...record, expectedRustupPath: expected.rustup,
        expectedRustupFileIdentity: expected.rustupFileIdentity,
        admission: 'exact-selected-path' });
      if (!admittedCargo.has(record.pid) && admittedCargo.size >= 4096) throw new Error('native Cargo admission evidence bound');
      admittedCargo.set(record.pid, record);
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  for (const record of versionCandidates) {
    const proof = {};
    try {
      versionProof(record, witnesses, admittedCargo, expected, proof);
      const admitted = versionProbeAdmission(record, expected, proof);
      if (!admitted) throw new Error('exact read-only compiler-query ownership predicates refused');
      witnesses.set(admitted.pid, proof.snapshot.members.find(item => item.pid === admitted.pid));
      versionProbeExceptions.push(admitted);
    } catch (cause) {
      const details = { kind: 'rustc-read-only-query-child', actual: record, expected,
        proof: proof ?? null, predicates: versionProbePredicates(record, expected, proof), cause: String(cause) };
      const error = new Error(`non-exempt compiler/test graph: ${JSON.stringify(details)}`, { cause });
      error.freshnessRefusal = details; throw error;
    }
  }
  return { exceptions, permissionFallbacks, witnessRefreshes, versionProbeExceptions };
}
function observationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['sample', 'prebuilt', 'tools', 'wallMs'].includes(key))
    || ('prebuilt' in options && typeof options.prebuilt !== 'boolean')) {
    throw new Error('native observation policy override refused');
  }
  return options;
}
// Every build and timed cohort call remains on this fixed benchmark policy.
export async function execute(command, directory, prefix, options = {}) {
  return executeImplementation(command, directory, prefix, observationOptions(options),
    { scope: 'normal-native-execution', intervalMs: 250 });
}
// Only the dependency-free startup control uses this named diagnostic policy.
// It changes observation probability, not admission predicates or timings.
export async function executeStartupControl(command, directory, prefix, options = {}) {
  return executeImplementation(command, directory, prefix, observationOptions(options),
    { scope: 'startup-control-only', intervalMs: 2 });
}
async function executeImplementation(command, directory, prefix, { sample = false, prebuilt = false, tools, wallMs = 180000 }, observationPolicy) {
  const executable = tools && ['bash', 'cargo'].includes(command[0]) ? tools[command[0]] : command[0];
  const paths = { stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` };
  const logs = Object.values(paths).map(path => createWriteStream(path, { flags: 'wx' }));
  const row = { status: 'pending', command, executable, directory, paths, observationPolicy, prebuilt, parentPid: process.pid, startedUTC: new Date().toISOString(), samples: [], cargoExceptions: [], versionProbeExceptions: [], permissionFallbacks: [], witnessRefreshes: [], nativeExecutableObservations: [],
    compilerSelection: tools ? { rustc: tools.rustc, rustdoc: tools.rustdoc, toolchain: tools.toolchain } : undefined };
  const witnesses = new Map(), admittedCargo = new Map(); let child, refusal, monitor, deadline, pipeDeadline, settle, exit, abortCleanup;
  const abort = reason => {
    refusal ??= String(reason);
    if (reason?.freshnessRefusal && !row.freshnessRefusal) row.freshnessRefusal = reason.freshnessRefusal;
    const witness = witnesses.get(child?.pid), current = child?.pid && processIdentity(child.pid);
    if (witness && current?.startTime === witness.startTime && current.pgrp === child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') refusal += `; ${error}`; }
    }
    abortCleanup ??= stopWitnessedProcesses([...witnesses.values()], 30000);
    pipeDeadline ??= setTimeout(() => { row.pipeTailCertified = false; child?.stdout.destroy(); child?.stderr.destroy(); child?.unref(); settle?.({ code: null }); }, 30000);
  };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort(`received ${signal}`)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  for (const log of logs) log.on('error', error => abort(`log write: ${error}`));
  try {
    child = spawn(executable, command.slice(1), { cwd: directory, detached: true,
      env: compilerEnvironment({ ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, tools), stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = processIdentity(child.pid); if (!identity) throw new Error('child PID witness absent'); witnesses.set(identity.pid, identity);
    row.initialProcessWitness = identity;
    let bytes = 0;
    [child.stdout, child.stderr].forEach((stream, index) => {
      stream.on('data', data => { bytes += data.length; if (bytes > 16 * 1024 ** 2) abort('native raw log 16MiB bound'); }); stream.pipe(logs[index], { end: false });
    });
    const observe = () => {
      try {
        const snapshot = ownedSnapshot(process.pid);
        for (const item of snapshot.members) witnesses.set(item.pid, item);
        if (row.samples.length >= 100000) throw new Error('native observation bound');
        row.samples.push({ at: snapshot.at, bytes: snapshot.bytes });
        if (snapshot.bytes > limits.rssBytes || available() < limits.liveBytes) throw new Error('native ownedRSS/live reserve refused');
        if (sample) {
          if (prebuilt) {
            // No Cargo/build/query exception in the FD-only timed protocol.
            const scan = noBuildGraphs();
            for (const item of scan.permissionFallbacks) if (!row.permissionFallbacks.some(prior => prior.pid === item.pid)) {
              if (row.permissionFallbacks.length >= 4096) throw new Error('native process observation evidence bound');
              row.permissionFallbacks.push(item);
            }
            let actual;
            try { actual = liveRecord(child.pid); }
            catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
            if (actual?.executable === tools?.nativeBinary && row.nativeExecutableObservations.length === 0) {
              if (actual.startTime !== identity.startTime || actual.pgrp !== identity.pgrp || actual.cwd !== directory) throw new Error('observed native PID/start/group/cwd changed');
              row.nativeExecutableObservations.push({ ...actual, scope: 'optional sampled /proc observation; no claim if short program unobserved' });
            }
            return;
          }
          const scan = graphScan(witnesses, admittedCargo, { ...tools, directory, group: child.pid });
          for (const [key, rows] of [['cargoExceptions', scan.exceptions], ['versionProbeExceptions', scan.versionProbeExceptions], ['permissionFallbacks', scan.permissionFallbacks], ['witnessRefreshes', scan.witnessRefreshes]]) {
            for (const item of rows) if (!row[key].some(prior => prior.pid === item.pid && prior.startTime === item.startTime)) {
              if (row[key].length >= 4096) throw new Error('native process observation evidence bound');
              row[key].push(item);
            }
          }
        }
      } catch (error) { abort(error); }
    };
    monitor = setInterval(observe, observationPolicy.intervalMs); observe(); deadline = setTimeout(() => abort('native child wall bound'), wallMs);
    exit = await new Promise((accept, reject) => { settle = accept; child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })); });
  } catch (error) { abort(error); }
  finally {
    clearInterval(monitor); clearTimeout(deadline); clearTimeout(pipeDeadline);
    row.cleanup = await stopWitnessedProcesses([...witnesses.values()], 30000);
    row.flush = await Promise.all(logs.map(log => finishLog(log, 30000)));
    if (abortCleanup) row.abortCleanup = await abortCleanup;
    row.exit = exit?.code ?? null; row.signal = exit?.signal ?? null; row.endedUTC = new Date().toISOString();
    try { row.hashes = await Promise.all(Object.values(paths).map(fileHash)); } catch (error) { refusal ??= `raw log hash: ${error}`; }
    if (refusal || row.exit !== 0 || row.pipeTailCertified === false || row.cleanup.status !== 'complete' || row.flush.some(item => item.status !== 'complete')) {
      row.status = 'refused'; row.reason = refusal ?? 'native child/cleanup/log refused';
    } else row.status = 'complete';
    clearTimeout(pipeDeadline);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  return row;
}
