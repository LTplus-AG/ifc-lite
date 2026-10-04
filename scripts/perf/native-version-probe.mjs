/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sameNativeFile } from './native-file-identity.mjs';
import { freshnessException, cargoWitnessRefreshPredicates } from './native-hosted-plan.mjs';

function pinnedStat(fd) {
  const stat = fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('pinned native executable is not a regular file');
  const bytes = Number(stat.size);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('pinned native executable size refused');
  return { fileIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, bytes };
}
function pinExecutable(source) {
  const fd = openSync(source.path, 'r');
  try {
    const actual = pinnedStat(fd);
    if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0 || actual.bytes !== source.bytes
      || !sameNativeFile(actual.fileIdentity, source.fileIdentity)) throw new Error('pinned native executable frozen binding refused');
    return { fd, ...actual };
  } catch (error) {
    try { closeSync(fd); } catch (cause) { throw new AggregateError([error, cause], 'pinned native executable refusal/close failed'); }
    throw error;
  }
}
// The caller observes live process binding after BOTH opens and before hashing.
// Closing the first FD is mandatory even if opening the second fails.
export function withPinnedNativeExecutables(sources, capture) {
  const pins = [], errors = []; let result;
  try {
    if (sources.length !== 2) throw new Error('two pinned native executables required');
    for (const source of sources) pins.push(pinExecutable(source));
    result = capture(pins);
  } catch (error) { errors.push(error); }
  finally { for (const pin of pins) { try { closeSync(pin.fd); } catch (error) { errors.push(error); } } }
  if (errors.length) throw new AggregateError(errors, 'pinned native executable capture/close refused');
  return result;
}
export function hashPinnedNativeExecutable(pin) {
  const before = pinnedStat(pin.fd);
  if (before.bytes !== pin.bytes || !sameNativeFile(before.fileIdentity, pin.fileIdentity)) throw new Error('pinned native executable changed before hashing');
  const hash = createHash('sha256'), chunk = Buffer.alloc(Math.min(65536, pin.bytes));
  let offset = 0;
  while (offset < pin.bytes) {
    const count = readSync(pin.fd, chunk, 0, Math.min(chunk.length, pin.bytes - offset), offset);
    if (count === 0) throw new Error('pinned native executable ended before frozen size');
    hash.update(chunk.subarray(0, count)); offset += count;
  }
  const extra = readSync(pin.fd, chunk, 0, 1, pin.bytes), after = pinnedStat(pin.fd);
  if (extra !== 0 || after.bytes !== pin.bytes || !sameNativeFile(before.fileIdentity, after.fileIdentity)) {
    throw new Error('pinned native executable changed while hashing');
  }
  return { ...after, sha256: hash.digest('hex') };
}
// Pinned Cargo target_info::new emits exactly this read-only host query.
// No alternate inputs, output paths, additional flags or generic --print allowlist.
const targetInfoArgs = ['-', '--crate-name', '___', '--print=file-names',
  '--crate-type', 'bin', '--crate-type', 'rlib', '--crate-type', 'dylib',
  '--crate-type', 'cdylib', '--crate-type', 'staticlib', '--crate-type', 'proc-macro',
  '--print=sysroot', '--print=split-debuginfo', '--print=crate-name', '--print=cfg', '-Wwarnings'];
export function rustcReadOnlyQueryKind(record, expected) {
  if (!record || record.executableObserved !== true || record.executable !== expected.rustc) return null;
  if (isDeepStrictEqual(record.argv, [expected.rustc, '-vV'])) return 'version';
  if (isDeepStrictEqual(record.argv, [expected.rustc, ...targetInfoArgs])) return 'cargo-target-info';
  return null;
}
const sameProcess = (left, right) => Boolean(left && right && left.pid === right.pid
  && left.startTime === right.startTime && left.pgrp === right.pgrp && left.ppid === right.ppid);
const sameObservedRecord = (left, right) => Boolean(sameProcess(left, right)
  && left.executableObserved === true && right.executableObserved === true
  && left.cwd === right.cwd && left.executable === right.executable
  && isDeepStrictEqual(left.argv, right.argv)
  && sameNativeFile(left.executableFileIdentity, right.executableFileIdentity));
const frozenHash = (actual, expected) => Boolean(/^[a-f0-9]{64}$/.test(expected ?? '') && actual === expected);

export function versionPostOpenBindings(record, expected, proof) {
  return Boolean(proof.currentChild && proof.currentParent && proof.postOpenChild && proof.postOpenParent
    && sameObservedRecord(proof.currentChild, proof.postOpenChild)
    && sameObservedRecord(proof.currentParent, proof.postOpenParent)
    && sameObservedRecord(record, proof.postOpenChild)
    && rustcReadOnlyQueryKind(proof.postOpenChild, expected) !== null
    && freshnessException(proof.postOpenParent, proof.parentWitness, expected)
    && Number.isSafeInteger(proof.pinsOpenedAt) && Number.isSafeInteger(proof.postOpenObservedAt)
    && proof.snapshot?.at <= proof.pinsOpenedAt && proof.pinsOpenedAt <= proof.postOpenObservedAt);
}
export function versionChildDisposition(record, proof) {
  const stat = proof.finalChildStat;
  if (stat?.observed !== true || !Object.hasOwn(stat, 'before') || !Object.hasOwn(stat, 'after')
    || stat.before === undefined || stat.after === undefined || (stat.before && !sameProcess(record, stat.before))
    || (stat.after && !sameProcess(record, stat.after))) return null;
  if (proof.finalChild && stat.before && stat.after && sameObservedRecord(proof.postOpenChild, proof.finalChild)
    && sameProcess(record, stat.after)) return 'still-live-after-pinned-hash';
  if (proof.finalChild === null && stat.after === null) return 'exited-after-pinned-observation';
  return null;
}
const frozenPin = (pin, expected, name) => Boolean(pin && Number.isSafeInteger(expected[`${name}FileBytes`])
  && expected[`${name}FileBytes`] > 0 && pin.bytes === expected[`${name}FileBytes`]
  && sameNativeFile(pin.fileIdentity, expected[`${name}FileIdentity`])
  && frozenHash(pin.sha256, expected[`${name}Sha256`]));

// Only the two exact read-only queries are admitted compiler children. A fresh common ancestry
// census and current live parent/child observations are mandatory, even when a
// previous scan already admitted the Cargo parent. No argv/permission fallback.
export function versionProbePredicates(record, expected, proof = {}) {
  const { snapshot, admittedParent, parentWitness, currentParent, currentChild,
    finalParent } = proof;
  const childMember = snapshot?.members?.find(item => item.pid === record.pid);
  const parentMember = snapshot?.members?.find(item => item.pid === record.ppid);
  const parentTool = currentParent?.executable === expected.cargo ? 'cargo'
    : currentParent?.executable === expected.rustup ? 'rustup' : null;
  const refresh = admittedParent && currentParent && snapshot
    ? cargoWitnessRefreshPredicates(admittedParent, expected, snapshot, currentParent) : null;
  return {
    freshCommonCensus: Boolean(Number.isSafeInteger(proof.captureStartedAt) && Number.isSafeInteger(snapshot?.at)
      && Number.isSafeInteger(proof.captureCompletedAt) && proof.captureStartedAt <= snapshot.at
      && snapshot.at <= proof.captureCompletedAt
      && Number.isSafeInteger(proof.postOpenObservedAt) && proof.postOpenObservedAt <= proof.captureCompletedAt),
    initialExactQuery: rustcReadOnlyQueryKind(record, expected) !== null,
    initialCompilerFileIdentity: sameNativeFile(record.executableFileIdentity, expected.rustcFileIdentity),
    currentExactQuery: Boolean(rustcReadOnlyQueryKind(record, expected)
      && rustcReadOnlyQueryKind(currentChild, expected) === rustcReadOnlyQueryKind(record, expected)
      && isDeepStrictEqual(record.argv, currentChild?.argv)),
    childSamePidStartGroupParent: sameProcess(record, currentChild),
    childSourceCwd: record.cwd === expected.directory && currentChild?.cwd === expected.directory,
    childOwnGroup: record.pgrp === expected.group && currentChild?.pgrp === expected.group,
    childFreshAncestry: sameProcess(record, childMember),
    parentFreshAncestry: Boolean(parentMember && currentParent && sameProcess(parentMember, currentParent)),
    directParent: Boolean(currentParent && currentChild && currentChild.ppid === currentParent.pid),
    parentPreviouslyAdmitted: Boolean(admittedParent && parentWitness
      && freshnessException(admittedParent, parentWitness, expected)),
    parentStillAdmitted: Boolean(currentParent && parentMember
      && freshnessException(currentParent, parentMember, expected)),
    parentSamePidStartGroupParent: sameProcess(admittedParent, currentParent),
    parentDirectedCargoContinuation: Boolean(refresh && Object.values(refresh).every(Boolean)),
    currentCompilerFileIdentity: sameNativeFile(currentChild?.executableFileIdentity, expected.rustcFileIdentity),
    pinnedCompilerBytesHashIdentity: frozenPin(proof.pinnedChild, expected, 'rustc'),
    currentParentFileIdentity: Boolean(parentTool
      && sameNativeFile(currentParent.executableFileIdentity, expected[`${parentTool}FileIdentity`])),
    pinnedParentBytesHashIdentity: Boolean(parentTool && frozenPin(proof.pinnedParent, expected, parentTool)),
    liveBindingsAfterBothFdOpens: versionPostOpenBindings(record, expected, proof),
    childFinalDispositionObserved: versionChildDisposition(record, proof) !== null,
    parentStillLiveAfterHashes: sameObservedRecord(currentParent, finalParent),
  };
}
export function versionProbeAdmission(record, expected, proof) {
  const predicates = versionProbePredicates(record, expected, proof);
  if (!Object.values(predicates).every(Boolean)) return null;
  return { ...proof.currentChild, admission: 'exact-frozen-rustc-read-only-child', queryKind: rustcReadOnlyQueryKind(record, expected),
    scope: 'exact frozen Cargo read-only query; no compiler-work exemption', predicates,
    parent: proof.currentParent, previouslyAdmittedParent: proof.admittedParent,
    parentWitness: proof.parentWitness, postOpenParent: proof.postOpenParent, postOpenChild: proof.postOpenChild,
    pinnedParent: proof.pinnedParent, pinnedChild: proof.pinnedChild, finalParent: proof.finalParent, finalChild: proof.finalChild,
    finalChildStat: proof.finalChildStat, childDisposition: versionChildDisposition(record, proof),
    ancestry: { at: proof.snapshot.at, captureStartedAt: proof.captureStartedAt, captureCompletedAt: proof.captureCompletedAt,
      child: proof.snapshot.members.find(item => item.pid === record.pid),
      parent: proof.snapshot.members.find(item => item.pid === record.ppid), depthBound: 32, processBound: 4096 },
    frozenRustc: { path: expected.rustc, sha256: expected.rustcSha256, bytes: expected.rustcFileBytes, fileIdentity: expected.rustcFileIdentity } };
}
