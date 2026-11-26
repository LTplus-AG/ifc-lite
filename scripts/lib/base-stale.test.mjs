// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The base-stale decision (scripts/lib/base-stale.mjs): perf-ratchet
// projection onto current main, the scoped Rust signal, and what `on` and
// `shadow` post. Numbers in the eager-bytes cases are queue run 45039295698's.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

// Guarded import (the scripts/perf-ratchet pattern, #6516): with the module
// reverted, every test fails on the presence assertion instead of the file
// dying at import with no assertion evaluated.
const url = new URL('./base-stale.mjs', import.meta.url);
const mod = existsSync(url) ? await import(url.href) : null;
const { combine, evaluatePerf, evaluateRust, FRESH, NOT_RELEVANT, parseGateMode, prRelevance, rustScope, STALE, statusFor, UNKNOWN } = mod ?? {};
function bt(name, body) {
  test(name, () => {
    assert.ok(mod, 'scripts/lib/base-stale.mjs is absent');
    return body();
  });
}

const PROV = { commit: 'abcdef1234567', measuredAt: '2026-11-22T00:00:00.000Z' };
const REL = { kind: 'relative', value: 0.001 };
const ceilingFile = (entries) => ({ family: 'bundle', entries: entries.map(([id, ceiling, tolerance = REL]) => ({ id, metric: 'raw-bytes', unit: 'bytes', ceiling, tolerance, provenance: PROV })) });
const measured = (metrics, commit = 'f00dfeed1234') => ({ family: 'bundle', commit, measuredAt: PROV.measuredAt, metrics: Object.entries(metrics).map(([id, value]) => ({ id, value })) });
const main = (sha, metrics, behindTip = 0) => ({ sha, behindTip, families: [measured(metrics, sha)] });

// Ceiling 13465339 * 1.001 floors to 13478804: an allowance of 13478804.
const EAGER = 'viewer-eager-js-bytes';
const ceilings = new Map([['bundle', ceilingFile([[EAGER, 13465339]])]]);
const ALLOWED = 13478804;

function perf(pr, { atBase = 13000000, latest = 13000000, behindTip = 0, ...rest } = {}) {
  return evaluatePerf({
    relevant: true,
    prMeasured: [measured({ [EAGER]: pr })],
    testedBase: 'aaaaaaaaa111',
    ceilings,
    mainAtBase: atBase === null ? null : main('aaaaaaaaa111', { [EAGER]: atBase }),
    mainLatest: latest === null ? null : main('bbbbbbbbb222', { [EAGER]: latest }, behindTip),
    ...rest,
  });
}

bt('exact at the allowance after projection still holds; one byte more is stale', () => {
  assert.equal(perf(ALLOWED - 100, { atBase: 13000000, latest: 13000100 }).verdict, FRESH);
  const over = perf(ALLOWED - 100, { atBase: 13000000, latest: 13000101 });
  assert.equal(over.verdict, STALE);
  assert.match(over.reasons[0], /projected 13478805 > allowed 13478804 by 1/);
});

bt('an exact-tolerance ceiling admits the ceiling itself and nothing above it', () => {
  const exact = new Map([['bundle', ceilingFile([['n', 1000, { kind: 'exact', value: 0 }]])]]);
  const run = (pr, drift) => evaluatePerf({ relevant: true, prMeasured: [measured({ n: pr })], testedBase: 'a1', ceilings: exact, mainAtBase: main('a1', { n: 10 }), mainLatest: main('b2', { n: 10 + drift }) });
  assert.equal(run(990, 10).verdict, FRESH);
  assert.equal(run(990, 11).verdict, STALE);
});

bt('within tolerance (above the ceiling, under the allowance) holds and says so', () => {
  const r = perf(13465339 + 5000, { atBase: 100, latest: 100 });
  assert.equal(r.verdict, FRESH);
  assert.match(r.rows[0].reason, /within tolerance/);
});

bt('main moved past: 45039295698 replayed, PR green on its base, stale on the new main', () => {
  // PR measured 13475666 on a4b4ab1; main grew +3199 by b191a3d; the queue
  // run measured 13478857 (stacked on one more PR) and failed.
  const r = perf(13475666, { atBase: 13470000, latest: 13473199 });
  assert.equal(r.verdict, STALE);
  assert.equal(r.rows[0].projected, 13478865);
  assert.match(r.reasons[0], /main \+3199 since/);
});

bt('main shrinking since the base helps the projection', () => {
  assert.equal(perf(ALLOWED + 50, { atBase: 13000000, latest: 12999900 }).verdict, STALE, 'a PR already above the allowance is stale whatever main did');
  assert.equal(perf(ALLOWED - 10, { atBase: 13000000, latest: 12999900 }).verdict, FRESH);
});

bt('a ceiling lowered on main since the PR ran is stale even when main drift is unmeasured', () => {
  const lowered = new Map([['bundle', ceilingFile([[EAGER, 13400000]])]]);
  const r = perf(13475666, { atBase: null, latest: null, ceilings: lowered });
  assert.equal(r.verdict, STALE);
  assert.match(r.reasons[0], /above current main's allowance/);
});

bt('no relevant change is not-relevant, and only from the PR file list', () => {
  const r = evaluatePerf({ relevant: false, prMeasured: null, testedBase: null, ceilings, mainAtBase: null, mainLatest: null });
  assert.equal(r.verdict, NOT_RELEVANT);
  const globs = { perfGlobs: ['apps/viewer/**', 'rust/**'], rustGlobs: ['rust/**', 'Cargo.lock'] };
  assert.deepEqual(prRelevance(['docs/guide/a.md'], globs), { perf: false, rust: false, editsCeilings: false });
  assert.deepEqual(prRelevance(['rust/core/src/lib.rs'], globs), { perf: true, rust: true, editsCeilings: false });
  assert.throws(() => prRelevance(['rust/x.rs'], { perfGlobs: [], rustGlobs: ['rust/**'] }), /empty filter globs/, 'no globs must not read as "nothing relevant"');
});

bt('a missing artifact is unknown, never fresh (no pass by absence)', () => {
  const noPr = evaluatePerf({ relevant: true, prMeasured: null, testedBase: 'a1', ceilings, mainAtBase: null, mainLatest: null });
  assert.equal(noPr.verdict, UNKNOWN);
  assert.equal(perf(13000000, { atBase: null }).verdict, UNKNOWN, 'main at the base unmeasured');
  assert.equal(perf(13000000, { latest: null }).verdict, UNKNOWN, 'recent main unmeasured');
  const missingMetric = perf(13000000, { latest: 1, atBase: 1, ceilings: new Map([['bundle', ceilingFile([[EAGER, 13465339], ['new-metric', 5]])]]) });
  assert.equal(missingMetric.verdict, UNKNOWN, "a ceiling the PR's run did not measure");
});

bt('a PR that edits ceilings is unknown: its merged ceilings are not main\'s', () => {
  assert.equal(perf(1, { editsCeilings: true }).verdict, UNKNOWN);
});

bt('a stale latest measurement is named when main was last measured behind its tip', () => {
  const r = perf(13000000, { behindTip: 3 });
  assert.equal(r.verdict, FRESH);
  assert.ok(r.reasons.some((x) => /3 commit\(s\) behind its tip/.test(x)));
});

const RUST = ['rust/**', 'Cargo.toml', 'Cargo.lock', 'apps/server/**'];
const rust = (prFiles, moved, testedBase = 'a1b2c3d4e') => evaluateRust({ relevant: prFiles.some((f) => f.startsWith('rust/') || f.startsWith('Cargo')), prFiles, rustGlobs: RUST, testedBase, moved });

bt('rust: main moved in the same crate is stale; another crate is fresh but counted', () => {
  const same = rust(['rust/export/src/a.rs'], { files: ['rust/export/src/b.rs', 'docs/x.md'], commits: 4, capped: false });
  assert.equal(same.verdict, STALE);
  assert.deepEqual(same.overlap, ['rust/export']);
  const other = rust(['rust/export/src/a.rs'], { files: ['rust/geometry/src/b.rs'], commits: 4, capped: false });
  assert.equal(other.verdict, FRESH);
  assert.equal(other.mainRustFiles, 1, 'the coarse tier still records that Rust moved');
});

bt('rust: a release bump of Cargo.toml does not overlap a crate; two workspace edits do', () => {
  assert.equal(rust(['rust/core/src/a.rs'], { files: ['Cargo.toml', 'Cargo.lock'], commits: 1, capped: false }).verdict, FRESH);
  assert.equal(rust(['Cargo.lock'], { files: ['Cargo.lock'], commits: 1, capped: false }).verdict, STALE);
});

bt('rust: no Rust move is fresh; not relevant, no base, unreadable or capped diff', () => {
  assert.equal(rust(['rust/core/a.rs'], { files: ['apps/viewer/a.ts'], commits: 9, capped: false }).verdict, FRESH);
  assert.equal(rust(['apps/viewer/a.ts'], null).verdict, NOT_RELEVANT);
  assert.equal(rust(['rust/core/a.rs'], { files: [], commits: 0, capped: false }, null).verdict, UNKNOWN);
  assert.equal(rust(['rust/core/a.rs'], null).verdict, UNKNOWN);
  assert.equal(rust(['rust/core/a.rs'], { files: ['rust/core/b.rs'], commits: 300, capped: true }).verdict, UNKNOWN);
});

bt('rustScope maps crates and the workspace files; other filter paths have no scope', () => {
  assert.equal(rustScope('rust/geometry/src/kernel/x.rs'), 'rust/geometry');
  assert.equal(rustScope('Cargo.lock'), 'workspace');
  assert.equal(rustScope('apps/server/src/main.rs'), 'apps/server');
  assert.equal(rustScope('scripts/build-wasm.sh'), null);
  assert.equal(rustScope('.github/workflows/test.yml'), null);
});

bt('rust: both sides editing test.yml (in the rust filter) is not a Rust overlap', () => {
  const r = evaluateRust({ relevant: true, prFiles: ['.github/workflows/test.yml', 'rust/core/a.rs'], rustGlobs: [...RUST, '.github/workflows/test.yml'], testedBase: 'a1', moved: { files: ['.github/workflows/test.yml'], commits: 3, capped: false } });
  assert.equal(r.verdict, FRESH);
  assert.equal(r.mainRustFiles, 1);
});

bt('a fresh perf verdict leads with the metric closest to its allowance', () => {
  const two = new Map([['bundle', ceilingFile([['roomy', 1000000], [EAGER, 13465339]])]]);
  const r = evaluatePerf({
    relevant: true,
    prMeasured: [measured({ roomy: 10, [EAGER]: ALLOWED - 7 })],
    testedBase: 'a1',
    ceilings: two,
    mainAtBase: main('a1', { roomy: 1, [EAGER]: 1 }),
    mainLatest: main('b2', { roomy: 1, [EAGER]: 1 }),
  });
  assert.equal(r.verdict, FRESH);
  assert.match(r.reasons[0], /viewer-eager-js-bytes: .* 7 to spare/);
});

bt('combine: the worst part wins and keeps only its reasons', () => {
  const s = { verdict: STALE, reasons: ['over'] };
  const u = { verdict: UNKNOWN, reasons: ['missing'] };
  const f = { verdict: FRESH, reasons: ['ok'] };
  const n = { verdict: NOT_RELEVANT, reasons: ['n/a'] };
  assert.deepEqual(combine(u, s), { verdict: STALE, reasons: ['rust: over'] });
  assert.deepEqual(combine(f, u).verdict, UNKNOWN, 'unknown beats fresh');
  assert.deepEqual(combine(n, f).verdict, FRESH);
  assert.deepEqual(combine(n, n).verdict, NOT_RELEVANT);
});

bt('gate mode: only the exact string `on` enforces', () => {
  assert.equal(parseGateMode('on'), 'on');
  assert.equal(parseGateMode(' on\n'), 'on');
  for (const v of [undefined, '', 'shadow', 'ON', 'true', 'off']) assert.equal(parseGateMode(v), 'shadow');
});

bt('on: stale fails, unknown says not judged, fresh succeeds; descriptions fit 140 chars', () => {
  const long = 'x'.repeat(300);
  const stale = statusFor({ verdict: STALE, reasons: [`perf: ${long}`] }, 'on');
  assert.equal(stale.state, 'failure');
  assert.ok(stale.description.length <= 140);
  assert.match(statusFor({ verdict: UNKNOWN, reasons: ['perf: no artifact'] }, 'on').description, /^Not judged \(advisory\): no artifact/);
  assert.equal(statusFor({ verdict: UNKNOWN, reasons: [] }, 'on').state, 'success');
  assert.equal(statusFor({ verdict: FRESH, reasons: [] }, 'on').state, 'success');
  assert.equal(statusFor({ verdict: NOT_RELEVANT, reasons: [] }, 'on').state, 'success');
});

bt('shadow posts nothing, except to release a failure an earlier `on` left', () => {
  assert.equal(statusFor({ verdict: STALE, reasons: ['x'] }, 'shadow', null), null);
  assert.equal(statusFor({ verdict: STALE, reasons: ['x'] }, 'shadow', 'success'), null);
  const released = statusFor({ verdict: STALE, reasons: ['x'] }, 'shadow', 'failure');
  assert.equal(released.state, 'success');
  assert.match(released.description, /shadow/);
});

bt('a family main measures now but not at the PR base is unknown, not fresh', () => {
  const nativeCeil = { family: 'native-instructions', entries: [{ id: 'scan', metric: 'instructions', unit: 'count', ceiling: 100, tolerance: REL, provenance: PROV }] };
  const both = new Map([...ceilings, ['native-instructions', nativeCeil]]);
  const nativeFam = { family: 'native-instructions', commit: 'bbbbbbbbb222', measuredAt: PROV.measuredAt, metrics: [{ id: 'scan', value: 90 }] };
  const latest = { sha: 'bbbbbbbbb222', behindTip: 0, families: [measured({ [EAGER]: 13000000 }, 'bbbbbbbbb222'), nativeFam] };
  const run = (atBaseFamilies) => evaluatePerf({
    relevant: true,
    prMeasured: [measured({ [EAGER]: 13000000 })],
    testedBase: 'aaaaaaaaa111',
    ceilings: both,
    mainAtBase: { sha: 'aaaaaaaaa111', families: atBaseFamilies },
    mainLatest: latest,
  });
  const fresh = run([measured({ [EAGER]: 13000000 }, 'aaaaaaaaa111')]);
  assert.equal(fresh.verdict, UNKNOWN, 'new on main since the base: the PR never measured it');
  assert.deepEqual(fresh.reasons, ["native-instructions: main measures this family since the PR's base aaaaaaaaa; the PR's run did not"]);
  // Main measured it at the base too: the PR's own path gate skipped it, as the queue will.
  assert.equal(run([measured({ [EAGER]: 13000000 }, 'aaaaaaaaa111'), { ...nativeFam, commit: 'aaaaaaaaa111' }]).verdict, FRESH);
});
