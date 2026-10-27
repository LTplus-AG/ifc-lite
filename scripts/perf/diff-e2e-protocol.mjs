/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: protocol utilities; no production engine imports or timing on import.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { roundOrder, seededRand } from './ab-order.mjs';

export const VERSION = 'ifc-diff-e2e/3';
export const OPTIONS = [
  { matchUnpairedByContent: true, detectSplitMerge: true, detectSuccessors: true },
];
export const LIMITS = Object.freeze({ pairs: 6, rows: 1_000_000,
  fixtureBytes: 512 * 1024 * 1024, retained: 10, timeoutMs: 10 * 60 * 1000 });

// Frozen before timing; identity remains independent of statistical inference.
export const ACCEPTANCE = Object.freeze({
  status: 'premeasurement-rule',
  primaryEndpoints: ['cold lifecycleTotalMs', 'warm per-process median public-call totalMs'],
  primaryCases: ['demo', 'haus', 'large'], options: [0],
  noninferiorityRatio: 1.10,
  statisticalMethod: 'paired percentile bootstrap median branch/base ratio; 95% pointwise CI; 10000 resamples; fixed seed 8042; no familywise speedup claim',
  inferenceUnit: 'fresh process pair; repeats summarized by process median',
  noise: { maximumArmRelativeRange: 0.20, definition: '(max-min)/median across process summaries' },
  contamination: 'failed admission, timeout, failure or changed identity blocks verdict; spread over 20% flags noisy and blocks a clean pass; preserve every observation',
  idle: 'standard exclusive physical-host admission and idle check at start; per-round load average and CPU deltas are descriptive, with no process classification',
  decision: 'regression if any lower CI exceeds 1.10; pass if every upper CI is at most 1.10 and no noise; otherwise inconclusive',
  timingScope: 'CLI fingerprints are data-only; geometry-enriched proof is separate required coverage',
  largeRevision: {
    permitted: 'real large IFC with an authored revision or a reproducible controlled derived IFC revision; independently authored revisions are not required by #8042',
    evidence: 'full STEP entity and IfcObjectDefinition counts for both files; author/source provenance; source/output SHA256; expected changed and content-match distribution for every option',
    derivation: 'controlled derived revision must be honestly labelled and include a reproducible recipe with SHA256; row expansion is not a large IFC revision',
    coverage: 'self-comparison alone does not qualify changed-path coverage',
  },
  requiredCoverage: ['real large IFC plus authored or reproducible controlled derived revision with the documented largeRevision evidence',
    'real geometry-enriched split/merge and successor coverage', 'actual Rust fingerprint pipeline',
    'exact output, Map order, optional fields and original reference identity'],
});

export function integer(value, min, max, label) {
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max,
    `${label} must be an integer in [${min}, ${max}]`);
  return value;
}

export function protocol({ pairs = 6, seed = 8042, dryRun = false,
  retained = 3, largeBase, largeHead, bindings = null } = {}) {
  integer(pairs, dryRun ? 1 : 6, dryRun ? 1 : 6, 'pairs');
  assert.equal(typeof dryRun, 'boolean');
  integer(seed, 0, 0xffff_ffff, 'seed');
  integer(retained, 1, LIMITS.retained, 'retained');
  assert.equal(Boolean(largeBase), Boolean(largeHead), 'supply both large paths');
  const demo = 'apps/viewer/public/samples/';
  const haus = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
  return {
    version: VERSION, dryRun, bindings, acceptance: ACCEPTANCE, execution: {
      primary: 'final public diffModels facade, handles packed/constructed/freed per call',
      cold: 'fresh process, one option, continuous imports/init/read/parse/fingerprints/call/release+GC',
      warm: 'separate fresh process, one untimed conditioning call, retained JS rows, repeated public calls',
      proof: 'separate audited processes before timing each fixture; no hashes in timing processes',
      optionOrder: [0], modeOrder: ['cold', 'warm'],
      caches: 'cold JS/WASM process; uncontrolled warm OS filesystem cache; no cache eviction',
    }, pairs, seed, retained, limits: LIMITS, options: OPTIONS,
    order: roundOrder(pairs, seededRand(seed)),
    cases: [
      { id: 'demo', paths: [demo + 'building-architecture.ifc', demo + 'building-architecture-rev-b.ifc'], kind: 'real' },
      { id: 'haus', paths: [haus, haus], kind: 'real' },
      ...(!dryRun ? [{ id: 'large', paths: largeBase ? [largeBase, largeHead] : [], kind: 'real',
        headSha256: 'f8e748cf1f2128609257c939aac9df40c6f62f70bbca6813ff5a67bb06ac853a' }] : []),
    ],
  };
}

export function validateProtocol(p) {
  assert.equal(p.version, VERSION);
  const expected = protocol({ pairs: p.pairs, seed: p.seed, retained: p.retained,
    dryRun: p.dryRun,
    largeBase: p.cases?.find(c => c.id === 'large')?.paths[0],
    bindings: p.bindings, largeHead: p.cases?.find(c => c.id === 'large')?.paths[1] });
  assert.deepEqual(p, expected, 'protocol changed; regenerate and review it');
  return p;
}

// Tagged traversal preserves absent vs undefined, Map order, -0 and nonfinites.
// Hash incrementally: do not create a second giant serialized result string.
export function digest(value, references = new Map()) {
  const hash = createHash('sha256');
  const active = new Set();
  function visit(v) {
    if (references.has(v)) { hash.update(`ref:${references.get(v)};`); return; }
    if (v === null || typeof v !== 'object') {
      // JSON escaping preserves lone UTF-16 surrogates before UTF-8 hashing.
      const data = typeof v === 'string' ? JSON.stringify(v)
        : typeof v === 'number' && Object.is(v, -0) ? '-0' : String(v);
      hash.update(`${typeof v}:${data.length}:${data};`); return;
    }
    assert.ok(!active.has(v), 'cyclic result is outside this protocol');
    active.add(v);
    if (v instanceof Map) {
      hash.update('map[');
      for (const [k, x] of v) { visit(k); visit(x); }
    } else if (Array.isArray(v)) {
      hash.update('array[');
      for (const x of v) visit(x);
    } else {
      assert.equal(Object.getPrototypeOf(v), Object.prototype, 'expected plain result object');
      hash.update('object[');
      for (const k of Object.keys(v).sort()) { visit(k); visit(v[k]); }
    }
    hash.update(']');
    active.delete(v);
  }
  visit(value);
  return hash.digest('hex');
}

export function nonempty(rows) {
  integer(rows.length, 1, LIMITS.rows, 'fingerprint count (run pnpm fixtures if absent)');
  return rows;
}

// Derived rows retain real type/data/component distributions, but are NOT a
// representative large IFC. Per-tile hashes avoid quadratic ambiguous buckets.
export function stress(source, count, head) {
  nonempty(source);
  integer(count, 1, LIMITS.rows, 'stress rows');
  return Array.from({ length: count }, (_, i) => {
    const row = source[i % source.length];
    const tile = Math.floor(i / source.length);
    return { ...row,
      key: `${row.key}/tile:${tile}${head && i % 29 === 0 ? '/replacement' : ''}`,
      dataHash: `${row.dataHash}/tile:${tile}${head && i % 23 === 0 ? '/edit' : ''}`,
      ref: { source: row.ref, row: i },
    };
  });
}

export function resultProof(result, base, head) {
  assert.ok(result.entries.length > 0, 'nonempty input must produce a nonempty diff');
  assert.equal(result.byKey.size, result.entries.length, 'byKey must contain exactly the entries');
  const references = new Map();
  base.forEach((row, i) => references.set(row, `base:${i}`));
  head.forEach((row, i) => references.set(row, `head:${i}`));
  const b = new Set(base), h = new Set(head);
  for (const entry of result.entries) {
    assert.equal(result.byKey.get(entry.key), entry, 'byKey must reuse entry objects');
    if (entry.base !== undefined) assert.ok(b.has(entry.base), 'base object identity lost');
    if (entry.head !== undefined) assert.ok(h.has(entry.head), 'head object identity lost');
  }
  for (const match of result.contentMatches ?? []) {
    match.base.forEach(row => assert.ok(b.has(row)));
    match.head.forEach(row => assert.ok(h.has(row)));
  }
  for (const claim of result.splitMerges ?? []) {
    const [whole, pieces] = claim.kind === 'split' ? [b, h] : [h, b];
    assert.ok(whole.has(claim.whole));
    claim.pieces.forEach(row => assert.ok(pieces.has(row)));
    if (claim.excluded !== undefined) assert.ok(pieces.has(claim.excluded));
  }
  for (const claim of result.successors ?? []) {
    assert.ok(b.has(claim.base)); assert.ok(h.has(claim.head));
  }
  return { sha256: digest(result, references), counts: result.counts };
}

export function fixtureInvariant(fixture, result, base, head) {
  if (fixture.id === 'haus') {
    assert.equal(result.counts.unchanged, base.length, 'Haus self-comparison lost entities');
    assert.equal(head.length, base.length);
    for (const key of ['added', 'modified', 'deleted']) assert.equal(result.counts[key], 0);
  } else if (fixture.id === 'demo' || fixture.id === 'large' || fixture.id === 'stress') {
    assert.ok(result.counts.added + result.counts.modified + result.counts.deleted > 0,
      'revision/stress pair must demonstrate a real change');
  }
}

export function distribution(values) {
  assert.ok(values.length > 0 && values.every(v => Number.isFinite(v) && v >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => sorted[Math.ceil(p * sorted.length) - 1];
  return { n: values.length, min: sorted[0], median: sorted.length % 2
    ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
  p95: percentile(0.95), max: sorted.at(-1), samples: values };
}

export function assertPair(base, branch) {
  assert.deepEqual(branch.rows, base.rows, 'input row counts differ');
  assert.deepEqual(branch.inputHashes, base.inputHashes, 'fingerprints differ');
  assert.deepEqual(branch.proofs, base.proofs, 'full diff output/identity differs');
}

// Resample whole pairs, never individual warm repeats. Pointwise intervals are
// descriptive endpoint decisions, not simultaneous significance or speedup claims.
export function endpointVerdict(base, branch) {
  assert.equal(base.length, branch.length);
  const ratios = base.map((v, i) => {
    assert.ok(v > 0 && Number.isFinite(v) && branch[i] > 0 && Number.isFinite(branch[i]));
    return branch[i] / v;
  });
  const rand = seededRand(8042), medians = [];
  for (let repeat = 0; repeat < 10000; repeat++) {
    medians.push(distribution(ratios.map(() => ratios[Math.floor(rand() * ratios.length)])).median);
  }
  medians.sort((a, b) => a - b);
  const ci95 = [medians[249], medians[9749]];
  const spread = values => {
    const d = distribution(values);
    return (d.max - d.min) / d.median;
  };
  const armSpread = { base: spread(base), branch: spread(branch) };
  const noisy = Object.values(armSpread).some(v => v > 0.20);
  return { medianRatio: distribution(ratios).median, ci95, armSpread, noisy,
    verdict: ratios.length < 5 ? 'dry-run-only' : ci95[0] > 1.10 ? 'regression'
      : noisy ? 'noisy' : ci95[1] <= 1.10 ? 'pass' : 'inconclusive' };
}

export function cohortVerdict(endpoints) {
  if (endpoints.some(e => e.verdict === 'regression')) return 'regression';
  if (endpoints.some(e => e.noisy)) return 'noisy';
  return endpoints.length && endpoints.every(e => e.verdict === 'pass') ? 'pass' : 'inconclusive';
}
