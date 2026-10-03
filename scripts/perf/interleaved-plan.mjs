/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Prospective, finite evidence protocol for #6537. No committed timing baseline.
export const FIXTURES = Object.freeze([
  { family: 'house', path: 'ara3d/AC20-FZK-Haus.ifc', timeoutMs: 180_000 },
  { family: 'csg', path: 'ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc', timeoutMs: 300_000 },
  { family: 'heavy-csg', path: 'ara3d/ISSUE_053_20181220Holter_Tower_10.ifc', timeoutMs: 600_000 },
  { family: 'architecture', path: 'various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc', timeoutMs: 600_000 },
]);
export const LIMITS = Object.freeze({
  cohortMs: 90 * 60_000, teardownMs: 30_000, identityMs: 120_000,
  sampledTreeRssBytes: 5 * 1024 ** 3, rssIntervalMs: 250,
  digestBytes: 2 * 1024 ** 3, oneBufferBytes: 64 * 1024 ** 2,
  records: 8_000_000, aaNoisePercent: 10,
});

export function immutableRef(value) {
  if (typeof value !== 'string' || value.length !== 40 || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('REFUSE: revision must be an immutable lowercase 40-hex commit');
  }
  return value;
}

export function schedule() {
  return FIXTURES.flatMap(fixture => {
    const rows = [];
    // One two-sample A/A pair per fixture, then five fixed alternating A/B pairs.
    for (let pair = 0; pair <= 5; pair++) {
      const order = pair === 0 ? ['base', 'base'] : pair % 2 ? ['base', 'candidate'] : ['candidate', 'base'];
      for (const [slot, arm] of order.entries()) rows.push({
        ...fixture, kind: pair === 0 ? 'AA' : 'AB', pair, slot, arm,
        id: `${fixture.family}-${pair}-${slot}-${arm}`,
      });
    }
    return rows;
  });
}

export function requireIdentityPair(a, b) {
  for (const row of [a, b]) {
    if (row.status !== 'complete' || !row.identity?.complete) {
      throw new Error(`REFUSE: incomplete sample ${row.id}`);
    }
    if (!(row.metrics?.metadataRenderReadyMs > 0)) throw new Error('REFUSE: missing full readiness boundary');
    const runtime = row.runtime;
    if (!runtime || !(runtime.hardwareConcurrency > 0) || !runtime.crossOriginIsolated || !runtime.sharedArrayBuffer
      || !(runtime.workerCount > 0) || typeof runtime.browserVersion !== 'string' || !runtime.browserVersion
      || !Array.isArray(runtime.workerIds) || runtime.workerIds.length !== runtime.workerCount) {
      throw new Error('REFUSE: missing default runtime census');
    }
  }
  if (a.identity.sha256 !== b.identity.sha256) throw new Error('REFUSE: exact output identity mismatch');
  if (a.runtime.hardwareConcurrency !== b.runtime.hardwareConcurrency
    || a.runtime.crossOriginIsolated !== b.runtime.crossOriginIsolated
    || a.runtime.sharedArrayBuffer !== b.runtime.sharedArrayBuffer
    || a.runtime.workerCount !== b.runtime.workerCount
    || a.runtime.browserVersion !== b.runtime.browserVersion
    || JSON.stringify(a.runtime.workerIds) !== JSON.stringify(b.runtime.workerIds)) {
    throw new Error('REFUSE: runtime or worker census changed within pair');
  }
  if (a.kind === 'AA') {
    const ratio = b.metrics.metadataRenderReadyMs / a.metrics.metadataRenderReadyMs;
    if (Math.abs(ratio - 1) * 100 > LIMITS.aaNoisePercent) throw new Error('REFUSE: A/A full readiness noise exceeds 10%');
  }
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export function describeFamily(rows) {
  if (rows.length !== 12) throw new Error('REFUSE: family requires all twelve prespecified samples');
  for (let i = 0; i < rows.length; i += 2) requireIdentityPair(rows[i], rows[i + 1]);
  const metrics = ['metadataRenderReadyMs', 'streamCompleteMs', 'metadataCompleteMs', 'dataModelParseMs',
    'entityScanMs', 'geometryStreamingMs', 'wasmWaitMs', 'jsProcessMs', 'fileReadMs'];
  return Object.fromEntries(metrics.map(metric => {
    const pairs = [];
    for (let i = 2; i < rows.length; i += 2) {
      const base = rows.slice(i, i + 2).find(row => row.arm === 'base');
      const candidate = rows.slice(i, i + 2).find(row => row.arm === 'candidate');
      const a = base.metrics[metric], b = candidate.metrics[metric];
      if (!(a > 0) || !(b >= 0)) return [metric, { available: false }];
      pairs.push((b / a - 1) * 100);
    }
    return [metric, { available: true, pairedPercent: pairs, medianPercent: median(pairs),
      rangePercent: [Math.min(...pairs), Math.max(...pairs)] }];
  }));
}
