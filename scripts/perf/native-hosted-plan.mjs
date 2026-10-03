/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { isDeepStrictEqual } from 'node:util';
import { fixtures, limits } from './sdk-plan.mjs';
export { limits };
export const revisions = Object.freeze({ base: '0a16f532ceb8f177d02ee29f4645e6f048fbace5', candidate: '07bdf45b5d470413d3796b3189d588a91a09a0d6' });
export const families = ['house', 'csg', 'heavy-csg'];
export const inputs = families.map(family => ({ family, ...fixtures[family] }));
export const methodPaths = ['scripts/perf/probe.sh', 'rust/processing/examples/perf_probe.rs',
  'rust/processing/examples/perf_probe/measurement.rs', 'rust/processing/examples/perf_probe/fingerprint.rs'];
export const cargoArgs = ['build', '--profile', 'profiling', '-p', 'ifc-lite-processing', '--example', 'perf_probe'];
export const phases = ['indexBuildMs', 'parseMs', 'entityScanMs', 'lookupMs', 'preprocessMs', 'geometryMs', 'facetedBrepMs', 'totalMs'];
const numeric = [...phases, 'fileMb', 'entities', 'meshes', 'vertices', 'triangles', 'pointCacheHits', 'pointCacheMisses', 'csgFailures', 'degenerateDropped'];
const fields = [...numeric, 'path', 'allTotalsMs', 'allWallMs', 'meshFingerprintsFnv1a64'];
export function schedule() {
  return [{ family: 'house', kind: 'AA', order: ['base', 'base'] }, { family: 'house', kind: 'AA', order: ['base', 'base'] },
    ...families.flatMap(family => Array.from({ length: 5 }, (_, index) => ({ family, kind: 'AB',
      order: index % 2 ? ['candidate', 'base'] : ['base', 'candidate'] })))];
}
export function validateRefs(base, candidate) {
  if (base !== revisions.base || candidate !== revisions.candidate) throw new Error('exact declared native subjects required');
}
export function probeResult(text, file) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('one complete canonical fixture required');
  const row = rows[0];
  if (!row || Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))
    || row.path !== file || numeric.some(key => !Number.isFinite(row[key]) || row[key] < 0)
    || ['entities', 'meshes', 'vertices', 'triangles', 'pointCacheHits', 'pointCacheMisses', 'csgFailures', 'degenerateDropped'].some(key => !Number.isSafeInteger(row[key]))
    || row.entities < 1 || row.meshes < 1 || row.vertices < 1 || row.triangles < 1 || row.totalMs < 1) throw new Error('canonical numeric/schema/path refused');
  for (const key of ['allTotalsMs', 'allWallMs']) {
    if (!Array.isArray(row[key]) || row[key].length !== 5 || row[key].some(value => !Number.isFinite(value) || value <= 0)
      || (key === 'allTotalsMs' && row[key].some(value => !Number.isSafeInteger(value)))) throw new Error('five raw timing iterations required');
  }
  if (row.totalMs !== Math.min(...row.allTotalsMs) || !Array.isArray(row.meshFingerprintsFnv1a64)
    || row.meshFingerprintsFnv1a64.length !== 5 || row.meshFingerprintsFnv1a64.some(value => !/^[a-f0-9]{16}$/.test(value))
    || new Set(row.meshFingerprintsFnv1a64).size !== 1) throw new Error('canonical best-total/fingerprint contract refused');
  return row;
}
export function freshnessLog(text) {
  if (/\bCompiling\b|\bChecking\b|\bRunning\s+.*(?:rustc|build-script)|error:|warning:|panic|retry|recover|skip /i.test(text)
    || (text.match(/^\s*Finished `profiling` profile \[optimized \+ debuginfo\] target\(s\) in [0-9.]+(?:ms|s)$/gm) ?? []).length !== 1) {
    throw new Error('canonical Cargo freshness/diagnostic log refused');
  }
}
export function freshnessException(record, witness, expected) {
  return Boolean(record.executableObserved === true && witness && record.pid === witness.pid && record.startTime === witness.startTime
    && record.pgrp === expected.group && record.cwd === expected.directory
    && [expected.cargo, expected.rustup].includes(record.executable)
    && record.argv[0]?.split('/').at(-1) === 'cargo' && isDeepStrictEqual(record.argv.slice(1), cargoArgs));
}
export function refreshedCargoWitness(record, expected, snapshot, current) {
  if (!freshnessException(record, record, expected) || !current || !freshnessException(current, record, expected)
    || current.executable !== record.executable || !isDeepStrictEqual(current.argv, record.argv)) return null;
  const member = snapshot.members.find(item => item.pid === record.pid);
  return member?.startTime === record.startTime && member.pgrp === record.pgrp ? member : null;
}
export function median(values) { return [...values].sort((a, b) => a - b)[2]; }
export function requirePair(left, right, control, witness) {
  const identity = row => [...['entities', 'meshes', 'vertices', 'triangles', 'csgFailures', 'degenerateDropped'].map(key => row[key]), row.meshFingerprintsFnv1a64];
  if (!isDeepStrictEqual(identity(left), identity(right)) || (witness && !isDeepStrictEqual(identity(left), identity(witness)))) throw new Error('native counts/ordered mesh FNV differ');
  const totals = [left, right].map(row => median(row.allTotalsMs)), walls = [left, right].map(row => median(row.allWallMs));
  if (control === 'AA' && [totals, walls].some(values => Math.abs(values[1] / values[0] - 1) > 0.10)) throw new Error('native A/A noise >10%');
  return { totalMediansMs: totals, wallMediansMs: walls, canonicalPhaseSelection: 'best total_time_ms iteration; not per-phase medians' };
}
export function requireCompletion(refusal, pairs, finalFrozenVerification) {
  if (refusal || finalFrozenVerification !== 'complete' || pairs.length !== 17 || pairs.some(row => row.status !== 'complete')) {
    throw new Error(refusal ?? 'native finite cohort/final freeze incomplete');
  }
}
