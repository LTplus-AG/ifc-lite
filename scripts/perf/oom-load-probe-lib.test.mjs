/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: the capped load test is a known-issue test. Its verdict must not be
// able to pass silently: a kill is never a pass in acceptance mode, and in
// known-issue mode the fix landing (loaded/refused) fails until the flag flips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Guarded load, not a static import: the revert oracle removes this PR's production files, and a
// static import of a removed module fails the whole file at LOAD, which the oracle cannot tell
// from a broken test. With the guard, every test fails by an ordinary assertion instead.
const LIB = new URL('./oom-load-probe-lib.mjs', import.meta.url);
const libModule = existsSync(LIB) ? await import(LIB.href) : null;
function lib() { assert.ok(libModule, 'scripts/perf/oom-load-probe-lib.mjs does not exist'); return libModule; }
const classify = (...a) => lib().classify(...a);
const optionErrors = (...a) => lib().optionErrors(...a);
const parseSize = (...a) => lib().parseSize(...a);
const phaseOf = (...a) => lib().phaseOf(...a);
const runCleanup = (...a) => lib().runCleanup(...a);
const verdict = (...a) => lib().verdict(...a);
const withTimeout = (...a) => lib().withTimeout(...a);
/** Server-proof exports this follow-up adds to the lib; asserted, so a revert fails by assertion. */
function serverApi() {
  const m = lib();
  for (const name of ['serverAttemptSummary', 'expectFlags', 'SERVER_FIRST']) assert.ok(m[name] !== undefined, `oom-load-probe-lib.mjs lacks the export ${name}`);
  return m;
}
const TRACKER = new URL('./oom-load-probe-tracker.mjs', import.meta.url);
const trackerModule = existsSync(TRACKER) ? await import(TRACKER.href) : null;
function trackerApi() { assert.ok(trackerModule, 'scripts/perf/oom-load-probe-tracker.mjs does not exist'); return trackerModule; }

test('#10264 a tab death wins over every other signal', () => {
  assert.equal(classify({ oomKills: 1, killedTypes: ['renderer'], pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ oomKills: 2, killedTypes: ['renderer'], pageCrashed: true, storeError: 'Ran out of memory while processing x' }).outcome, 'killed');
  assert.equal(classify({ pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ pageClosed: true }).outcome, 'killed');
  assert.equal(classify({ browserGone: true }).outcome, 'killed');
});

test('#10264 only the explicit pre-read refusal text is `refused`', () => {
  const r = classify({ notices: ["This IFC file exceeds this tab's local processing memory budget (6.0 GiB budget)."] });
  assert.equal(r.outcome, 'refused');
  assert.match(r.reason, /local processing memory budget/);
  assert.equal(classify({ storeError: "This IFC file exceeds this tab's local processing memory budget" }).outcome, 'refused');
});

test('#10264 "Ran out of memory while processing" is always `error`, even with no read observed', () => {
  // An entity-heavy pre-pass can fail before any triangle streams, and worker-side reads are invisible
  // to the probe: an unobserved start must not read as a refusal (review on #10415).
  const oom = 'Ran out of memory while processing big.ifc. This usually means the model is too large for this device\'s available memory.';
  for (const extra of [{}, { loadStarted: false }, { loadStarted: true }, { notices: [oom] }]) {
    const r = classify({ storeError: oom, ...extra });
    assert.equal(r.outcome, 'error');
    assert.equal(verdict(r.outcome, 'not-killed').pass, false);
  }
});

test('#10264 crash messages that leave the tab alive are `error`, never `refused`', () => {
  // geometry_worker_crash and wasm_runtime_crashed in apps/viewer/src/lib/load-error-message.ts
  const worker = 'A geometry worker stopped unexpectedly while processing big.ifc. This usually means the model is too large for this device\'s available memory.';
  const runtime = "The 3D geometry engine crashed and can't restart in this tab. If it happens again on the same model, it is likely too large for this device's memory.";
  for (const storeError of [worker, runtime]) {
    assert.equal(classify({ storeError }).outcome, 'error');
    assert.equal(verdict(classify({ storeError }).outcome, 'not-killed').pass, false);
  }
});

test('#10264 a finished load is `loaded` whatever text is on the page', () => {
  assert.equal(classify({ interactive: true, notices: ['Your memory budget settings'] }).outcome, 'loaded');
  assert.equal(classify({ interactive: true, storeError: null, notices: ["exceeds this tab's local processing memory budget"] }).outcome, 'loaded');
});

test('#10264 killed rests on evidence about this tab: its renderer crashed, its page closed, or the browser exited', () => {
  assert.equal(classify({ oomKills: 1, killedTypes: ['renderer'], pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ browserGone: true }).outcome, 'killed');
  assert.match(classify({ oomKills: 1, killedTypes: ['renderer'], pageCrashed: true }).reason, /page crashed \(its renderer died\) \(cgroup oom_kill=1; vanished: renderer\)/);
  // A vanished renderer TYPE alone is not this tab: with no tab evidence it never decides killed.
  assert.notEqual(classify({ oomKills: 1, killedTypes: ['renderer'] }).outcome, 'killed');
  assert.equal(classify({ pageCrashed: true }).outcome, 'killed');
});

test('#10264 GPU-only OOM kill, then the load finishes: `loaded` with a note', () => {
  const r = classify({ oomKills: 1, killedTypes: ['gpu-process'], interactive: true });
  assert.equal(r.outcome, 'loaded');
  assert.match(r.reason, /OOM-killed gpu-process \(not the tab\)/);
  assert.equal(verdict(r.outcome, 'killed').pass, false);
});

test('#10264 GPU-only OOM kill, then the page crashes: `killed`', () => {
  assert.equal(classify({ oomKills: 2, killedTypes: ['gpu-process', 'renderer'], pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ oomKills: 1, killedTypes: ['gpu-process'], pageCrashed: true }).outcome, 'killed');
});

test('#10264 GPU-only OOM kill, then the time limit: `timeout`, a pass for neither expectation', () => {
  const r = classify({ oomKills: 1, killedTypes: ['utility'], timedOut: true });
  assert.equal(r.outcome, 'timeout');
  assert.match(r.reason, /OOM-killed utility/);
  for (const e of ['killed', 'not-killed']) assert.equal(verdict(r.outcome, e).pass, false);
});

test('#10264 OOM kill with an unidentified victim and a live page: `error`, a pass for neither expectation', () => {
  for (const extra of [{}, { interactive: true }, { timedOut: true }]) {
    const r = classify({ oomKills: 1, killedTypes: [], ...extra });
    assert.equal(r.outcome, 'error');
    assert.match(r.reason, /kill\(s\) whose victim was not identified/);
    for (const e of ['killed', 'not-killed', 'warned']) assert.equal(verdict(r.outcome, e).pass, false);
  }
});

test('#10264 other outcomes: loaded, non-memory error, timeout', () => {
  assert.equal(classify({ interactive: true }).outcome, 'loaded');
  assert.equal(classify({ storeError: 'Unsupported schema IFC9' }).outcome, 'error');
  assert.equal(classify({ timedOut: true }).outcome, 'timeout');
  assert.equal(classify({}).outcome, 'error');
});

test('#10264 known-issue mode passes only on a kill and fails loudly once the fix lands', () => {
  assert.equal(verdict('killed', 'killed').pass, true);
  for (const fixed of ['loaded', 'refused']) {
    const v = verdict(fixed, 'killed');
    assert.equal(v.pass, false);
    assert.match(v.message, /--expect not-killed/);
  }
  for (const broken of ['error', 'timeout']) assert.equal(verdict(broken, 'killed').pass, false);
});

test('#10264 acceptance mode passes on loaded or refused, never on killed/error/timeout', () => {
  assert.equal(verdict('loaded', 'not-killed').pass, true);
  assert.equal(verdict('refused', 'not-killed').pass, true);
  for (const bad of ['killed', 'error', 'timeout']) assert.equal(verdict(bad, 'not-killed').pass, false);
  assert.throws(() => verdict('loaded', 'whatever'), /--expect must be one of/);
  assert.throws(() => verdict('loaded', 'constructor'), /--expect must be one of/);
});

test('#10264 cap sizes and phase labels', () => {
  assert.equal(parseSize('3G'), 3 * 2 ** 30);
  assert.equal(parseSize('1536M'), 1536 * 2 ** 20);
  assert.equal(parseSize('1048576'), 2 ** 20);
  assert.throws(() => parseSize('3 GB'), /bad size/);
  assert.equal(phaseOf(null), 'before-open');
  assert.equal(phaseOf({ loading: true, progress: { phase: 'Parsing' }, tris: 0 }), 'pre-geometry (Parsing)');
  assert.equal(phaseOf({ loading: true, tris: 10 }), 'geometry-streaming');
  assert.equal(phaseOf({ loading: false, tris: 10, progress: { phase: 'Complete', percent: 100 } }), 'geometry complete (not yet interactive)');
  assert.equal(phaseOf({ interactive: true, tris: 10 }), 'loaded');
});

test('#10264 a pre-load memory warning: waiting, cancelling and continuing are distinct outcomes', () => {
  assert.equal(classify({ warningShown: true }).outcome, 'awaiting-decision');
  assert.equal(classify({ warningShown: true, decision: 'cancel' }).outcome, 'cancelled');
  assert.equal(classify({ warningShown: true, decision: 'continue', interactive: true }).outcome, 'loaded');
  // A kill after the user accepted the warning is reported on its own, never as plain `killed`.
  assert.equal(classify({ warningShown: true, decision: 'continue', oomKills: 1, killedTypes: ['renderer'], pageCrashed: true }).outcome, 'killed-after-continue');
  assert.equal(classify({ warningShown: true, decision: 'continue', pageCrashed: true }).outcome, 'killed-after-continue');
  // An outright refusal below the warning threshold is still `refused`.
  assert.equal(classify({ storeError: "This IFC file exceeds this tab's local processing memory budget" }).outcome, 'refused');
});

test('#10264 killed-after-continue fails acceptance; passes only the explicit warned mode, and says so', () => {
  assert.equal(verdict('killed-after-continue', 'not-killed').pass, false);
  const warned = verdict('killed-after-continue', 'warned');
  assert.equal(warned.pass, true);
  assert.match(warned.message, /AFTER the user clicked Continue loading/);
  assert.equal(verdict('killed', 'warned').pass, false);
  for (const ok of ['awaiting-decision', 'cancelled']) assert.equal(verdict(ok, 'not-killed').pass, true);
  // The known-issue run fails once a warning appears instead of the kill.
  assert.equal(verdict('awaiting-decision', 'killed').pass, false);
  assert.equal(phaseOf({ warning: true, tris: 0 }), 'memory warning (load not started)');
});

test('#10264 CLI options are validated before anything runs', () => {
  const ok = { expect: 'killed', cap: '3G', kind: 'tfs', 'target-mb': '300', cores: '4', 'device-memory': '4', 'cpu-quota': '400%' };
  assert.deepEqual(optionErrors(ok), []);
  const bad = (patch) => optionErrors({ ...ok, ...patch });
  assert.match(bad({ expect: 'constructor' }).join(), /--expect is required/);
  assert.match(bad({ kind: '../x' }).join(), /--kind must be tfs or brep/);
  for (const k of ['target-mb', 'cores', 'device-memory', 'limit-min']) {
    for (const v of ['', 'abc', '-1', '0', '0x4']) assert.match(bad({ [k]: v }).join(), new RegExp(`--${k} must be a positive number`));
  }
  assert.match(bad({ 'cpu-quota': "400%' ; rm -rf ~ '" }).join(), /--cpu-quota must look like 400%/);
  assert.match(bad({ cap: '3 GB' }).join(), /--cap/);
  assert.match(bad({ gl: 'vulkan' }).join(), /--gl/);
  assert.match(bad({ 'on-memory-dialog': 'yes' }).join(), /--on-memory-dialog/);
  assert.deepEqual(bad({ 'watch-url': 'http://127.0.0.1:9' }), []);
  assert.match(bad({ 'watch-url': '127.0.0.1:9' }).join(), /--watch-url must be an http\(s\) URL/);
});

test('#10264 cleanup runs every step even when one throws, last registered first', async () => {
  const ran = [];
  const steps = [
    { name: 'fixture', fn: () => ran.push('fixture') },
    { name: 'scope', fn: () => { ran.push('scope'); throw new Error('systemctl failed'); } },
    { name: 'browser', fn: async () => { ran.push('browser'); } },
  ];
  const failures = await runCleanup(steps);
  assert.deepEqual(ran, ['browser', 'scope', 'fixture']);
  assert.deepEqual(failures, ['scope: systemctl failed']);
  assert.equal(steps.length, 0, 'a second run (signal after finish) does nothing');
});

test('#10264 withTimeout falls back when a close hangs', async () => {
  assert.equal(await withTimeout(new Promise(() => {}), 20, () => 'forced'), 'forced');
  assert.equal(await withTimeout(Promise.resolve('closed'), 1000, () => 'forced'), 'closed');
});

const facts = (f = {}, extra = {}) => ({ reported: true, pickKnown: true, sourceMarked: true, truncated: false, requestsBeforePick: 0, requestsAfterPick: 0, failuresAfterPick: 0,
  facts: { firstLargeSourceRead: null, firstUnattributedRead: null, firstSourcePost: null, firstOtherPost: null, firstRequestAfterPick: null, startupRequests: [], ...f }, ...extra });
/** Tracker summary with page-clock requests: `after` / `before` are ms relative to the page pick. */
const withRequests = ({ after = [], before = [], failures = 0 } = {}, f = {}, extra = {}) => facts(
  { firstRequestAfterPick: after.length ? { ms: Math.min(...after) } : null, startupRequests: before.map((ms) => ({ ms })), ...f },
  { requestsAfterPick: after.length, requestsBeforePick: before.length, failuresAfterPick: failures, ...extra });

test('#10353 server proof: a failed server attempt before the warning, no read or post before it', async () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const s = serverAttemptSummary([
    { ms: 40, event: 'request', clock: 'page', url: 'http://127.0.0.1:9/api/v1/health' },
    { ms: 42, event: 'requestfailed', clock: 'page', failure: 'net::ERR_CONNECTION_REFUSED' },
    { ms: 60, event: 'dialog', text: 'This model may exceed available memory\nThis model may need about 6.0 GiB' },
  ], { watching: true, tracker: withRequests({ after: [40], failures: 1 }) });
  assert.deepEqual(s, { watched: true, trackerReported: true, sourceMarked: true, pickKnown: true, attempts: 1, failures: 1, failureCode: null, startupRequests: { count: 0, ms: [] }, firstAttemptMs: 40, firstDecisionMs: 60, decisionWindowMs: 0,
    attemptBeforeDecision: true, readBeforeDecision: false, unattributedReadBeforeDecision: false, sourcePostBeforeDecision: false, logTruncated: false, channels: null });
  assert.equal(expectFlags(s, SERVER_FIRST).pass, true);
});

test('#10353 server proof: verdicts come from kept facts, so a truncated log cannot hide a large read', async () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const dialog = { ms: 600, event: 'dialog', text: 'This model may exceed available memory' };
  const req = { ms: 10, event: 'request', clock: 'page' };
  // 500 small reads then a whole-file read before the decision; the log dropped the middle.
  const early = serverAttemptSummary([req, dialog], { watching: true, tracker: facts({ firstLargeSourceRead: { ms: 501, bytes: 740e6 } }, { truncated: true }) });
  assert.equal(early.readBeforeDecision, true);
  assert.equal(early.logTruncated, true);
  assert.equal(expectFlags(early, SERVER_FIRST).pass, false);
  // Same, whole-file read after the decision (Continue): order is right.
  const late = serverAttemptSummary([req, dialog], { watching: true, tracker: facts({ firstLargeSourceRead: { ms: 900, bytes: 740e6 } }, { truncated: true }) });
  assert.equal(late.readBeforeDecision, false);
  const post = serverAttemptSummary([req, dialog], { watching: true, tracker: facts({ firstSourcePost: { ms: 300, worker: 'w.js' }, firstUnattributedRead: { ms: 5, bytes: 2e6 } }) });
  assert.equal(post.sourcePostBeforeDecision, true);
  assert.equal(post.unattributedReadBeforeDecision, true);
});

test('#10353 server proof: a refusal seen only by the poll makes events inside its window unknown', async () => {
  const { serverAttemptSummary } = serverApi();
  const polled = { ms: 2031, event: 'store-error', windowMs: 2000, text: "This IFC file exceeds this tab's local processing memory budget" };
  const s = serverAttemptSummary([{ ms: 155, event: 'request', clock: 'page' }, polled], { watching: true, tracker: withRequests({ after: [155] }, { firstSourcePost: { ms: 1500, worker: 'w.js' } }) });
  assert.equal(s.decisionWindowMs, 2000);
  assert.equal(s.attemptBeforeDecision, null, '155 ms is inside (31, 2031]: the refusal may have come first');
  assert.equal(s.sourcePostBeforeDecision, null);
  // A precise stamp (store subscription or notice) settles it.
  const precise = serverAttemptSummary([{ ms: 155, event: 'request', clock: 'page' }, { ms: 400, event: 'notice', text: "Failed to load: exceeds this tab's local processing memory budget" }, polled],
    { watching: true, tracker: withRequests({ after: [155] }, { firstSourcePost: { ms: 1500, worker: 'w.js' } }) });
  assert.equal(precise.firstDecisionMs, 400);
  assert.equal(precise.attemptBeforeDecision, true);
  assert.equal(precise.sourcePostBeforeDecision, false);
});

test('#10445 server proof: the open polling-window boundary is provably before the decision', () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const polled = { ms: 2031, event: 'store-error', windowMs: 2000, text: "This IFC file exceeds this tab's local processing memory budget" };
  for (const [ms, expected] of [[30, true], [31, true], [32, null], [2030, null], [2031, false], [2032, false]]) {
    const summary = serverAttemptSummary([polled], { watching: true, tracker: withRequests({ after: [ms] }) });
    assert.equal(summary.attemptBeforeDecision, expected, `request at ${ms} ms relative to (31, 2031]`);
    if (ms === 31) assert.equal(expectFlags(summary, SERVER_FIRST).pass, true, 'the boundary request satisfies server-first');
  }
  const precise = serverAttemptSummary([{ ...polled, windowMs: 0 }], { watching: true, tracker: withRequests({ after: [2031] }) });
  assert.equal(precise.attemptBeforeDecision, false, 'simultaneous events are not strictly ordered');
});

test('#10353 server proof: unreported instrumentation gives null, and null never passes', async () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const dialog = { ms: 5, event: 'dialog', text: 'This model may exceed available memory' };
  const noTracker = serverAttemptSummary([{ ms: 1, event: 'request', clock: 'page' }, dialog], { watching: true, tracker: { reported: false } });
  assert.equal(noTracker.readBeforeDecision, null, 'no tracker report is unknown, not "no read"');
  assert.equal(noTracker.sourcePostBeforeDecision, null);
  assert.equal(noTracker.unattributedReadBeforeDecision, null);
  assert.equal(noTracker.logTruncated, null);
  assert.equal(noTracker.attemptBeforeDecision, null, 'no tracker: no page pick stamp, so no order');
  assert.match(expectFlags(noTracker, SERVER_FIRST).message, /readBeforeDecision=unknown/);
  assert.equal(expectFlags(noTracker, SERVER_FIRST).pass, false);
  const unwatched = serverAttemptSummary([dialog], { watching: false, tracker: facts() });
  assert.equal(unwatched.attempts, null);
  assert.equal(unwatched.attemptBeforeDecision, null);
  assert.equal(serverAttemptSummary([dialog], { watching: true, tracker: facts() }).attemptBeforeDecision, false);
  const noDecision = serverAttemptSummary([{ ms: 1, event: 'request', clock: 'page' }], { watching: true, tracker: facts() });
  assert.equal(noDecision.firstDecisionMs, null);
  assert.equal(noDecision.attemptBeforeDecision, null);
  assert.equal(noDecision.readBeforeDecision, null);
  assert.equal(serverAttemptSummary([{ ms: 1, event: 'dialog', text: 'IFClite stores an action log' }], { watching: true, tracker: facts() }).firstDecisionMs, null);
});

test('#10353 server proof: a request during viewer startup is not the attempt for this load (review on #10415)', async () => {
  const { serverAttemptSummary } = serverApi();
  const dialog = { ms: 50, event: 'dialog', text: 'This model may exceed available memory' };
  const onlyStartup = serverAttemptSummary([{ ms: -800, event: 'request', clock: 'page' }, { ms: -799, event: 'requestfailed', clock: 'page' }, dialog], { watching: true, tracker: withRequests({ before: [-800] }) });
  assert.equal(onlyStartup.attemptBeforeDecision, false, 'instrument present, no attempt for this load');
  assert.equal(onlyStartup.attempts, 0);
  assert.equal(onlyStartup.failures, 0);
  assert.deepEqual(onlyStartup.startupRequests, { count: 1, ms: [-800] });
  const both = serverAttemptSummary([{ ms: -800, event: 'request', clock: 'page' }, { ms: 20, event: 'request', clock: 'page' }, dialog], { watching: true, tracker: withRequests({ before: [-800], after: [20] }) });
  assert.equal(both.firstAttemptMs, 20);
  assert.equal(both.attemptBeforeDecision, true);
  assert.equal(both.attempts, 1);
});

test('#10353 server proof: an unmarked source or an unattributed large event before the decision makes identity flags null (review on #10415)', async () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const tl = [{ ms: 5, event: 'request', clock: 'page' }, { ms: 50, event: 'dialog', text: 'This model may exceed available memory' }];
  const unmarked = serverAttemptSummary(tl, { watching: true, tracker: facts({ firstUnattributedRead: { ms: 30, bytes: 740e6 } }, { sourceMarked: false }) });
  assert.equal(unmarked.sourceMarked, false);
  assert.equal(unmarked.readBeforeDecision, null);
  assert.equal(unmarked.sourcePostBeforeDecision, null);
  assert.match(unmarked.unknownBecause.readBeforeDecision, /never marked/);
  assert.equal(expectFlags(unmarked, SERVER_FIRST).pass, false);
  const lookalike = serverAttemptSummary(tl, { watching: true, tracker: facts({ firstUnattributedRead: { ms: 30, bytes: 2e6 }, firstOtherPost: { ms: 40, bytes: 3e6, worker: 'x.js' } }) });
  assert.equal(lookalike.readBeforeDecision, null);
  assert.equal(lookalike.sourcePostBeforeDecision, null);
  assert.match(lookalike.unknownBecause.readBeforeDecision, /unattributed read of 2000000 bytes at 30 ms/);
  assert.match(lookalike.unknownBecause.sourcePostBeforeDecision, /worker post of another Blob of 3000000 bytes/);
  // After the decision they do not matter.
  const later = serverAttemptSummary(tl, { watching: true, tracker: facts({ firstUnattributedRead: { ms: 90, bytes: 2e6 }, firstOtherPost: { ms: 95, bytes: 3e6 } }) });
  assert.equal(later.readBeforeDecision, false);
  assert.equal(later.sourcePostBeforeDecision, false);
  assert.equal(later.unknownBecause, undefined);
  // A positive source event is still true even when the source was not marked by the input.
  assert.equal(serverAttemptSummary(tl, { watching: true, tracker: facts({ firstLargeSourceRead: { ms: 10, bytes: 1e6 } }, { sourceMarked: false }) }).readBeforeDecision, true);
});

test('#10353 server proof: a blob: URL of the source before the decision makes the post verdict null', async () => {
  const { serverAttemptSummary } = serverApi();
  const v = serverAttemptSummary([{ ms: 1, event: 'request', clock: 'page' }, { ms: 50, event: 'dialog', text: 'This model may exceed available memory' }],
    { watching: true, tracker: facts({ firstSourceObjectUrl: { ms: 20, url: 'blob:x' } }) });
  assert.equal(v.sourcePostBeforeDecision, null);
  assert.match(v.unknownBecause.sourcePostBeforeDecision, /blob: URL of the source/);
});

test('#10264 the final snapshot decides, not which promise settled first (review on #10415)', async () => {
  const { mergeFinalSnapshot } = lib();
  const refusal = "Failed to load \"x.ifc\": This IFC file exceeds this tab's local processing memory budget (3.0 GiB estimated, 3.0 GiB budget).";
  // The wait rejected before the first poll: obs has no storeError yet.
  const rejected = { oomKills: 0, killedTypes: [], interactive: false, storeError: null, notices: [], timedOut: false, warningShown: false, decision: 'none' };
  assert.equal(classify(mergeFinalSnapshot(rejected, { error: refusal, modelStates: ['error'], warningVisible: false, notices: [] })).outcome, 'refused');
  assert.equal(classify(mergeFinalSnapshot(rejected, { error: null, modelStates: [], warningVisible: false, notices: [] })).outcome, 'error', 'no refusal anywhere: error');
  assert.equal(classify(mergeFinalSnapshot(rejected, { error: 'Unsupported schema', modelStates: ['error'], warningVisible: false, notices: [] })).outcome, 'error');
  // Refusal shown only as an error card (notice), not yet in the store sample.
  assert.equal(classify(mergeFinalSnapshot(rejected, { error: null, modelStates: [], warningVisible: false, notices: [refusal] })).outcome, 'refused');
  // The warning dialog appeared just before a rejection: awaiting-decision.
  assert.equal(classify(mergeFinalSnapshot(rejected, { error: null, modelStates: [], warningVisible: true, notices: [] })).outcome, 'awaiting-decision');
  // After Cancel the dialog is gone; the decision recorded earlier still gives cancelled.
  assert.equal(classify(mergeFinalSnapshot({ ...rejected, warningShown: true, decision: 'cancel' }, { error: null, modelStates: [], warningVisible: false, notices: [] })).outcome, 'cancelled');
  // A timeout with a refusal in the store is a refusal, and a finished load stays loaded.
  assert.equal(classify(mergeFinalSnapshot({ ...rejected, timedOut: true }, { error: refusal, modelStates: [], warningVisible: false, notices: [] })).outcome, 'refused');
  assert.equal(classify(mergeFinalSnapshot({ ...rejected, interactive: true }, { error: null, modelStates: ['complete'], warningVisible: false, notices: [] })).outcome, 'loaded');
  // Page gone (crash): no snapshot; the kill evidence decides.
  assert.equal(classify(mergeFinalSnapshot({ ...rejected, pageCrashed: true }, null)).outcome, 'killed');
  // An earlier poll's storeError is never overwritten.
  assert.equal(mergeFinalSnapshot({ ...rejected, storeError: 'first' }, { error: 'second', modelStates: [], notices: [] }).storeError, 'first');
});

// Precedence: each test builds observations where BOTH adjacent rows match, so the higher
// row must win. Changing the order of PRECEDENCE breaks exactly the pair that moved.
const base = { oomKills: 0, killedTypes: [], pageCrashed: false, browserGone: false, interactive: false, storeError: null, notices: [], timedOut: false, warningShown: false, decision: 'none' };
const REFUSAL_TEXT = "This IFC file exceeds this tab's local processing memory budget (3.0 GiB estimated, 3.0 GiB budget).";
const OOM_TEXT = 'Ran out of memory while processing x.ifc.';

test('precedence: the table order is pinned', async () => {
  const { PRECEDENCE } = lib();
  assert.deepEqual(PRECEDENCE.map((r) => r.outcome), ['killed', 'error', 'loaded', 'refused', 'error', 'error', 'cancelled', 'awaiting-decision', 'timeout', 'error']);
});

test('precedence 1>2: tab death beats an OOM kill with an unknown victim', () => {
  const r = classify({ ...base, oomKills: 2, killedTypes: [], pageCrashed: true });
  assert.equal(r.outcome, 'killed');
  assert.equal(r.rule, 1);
});

test('precedence 2>3: an unidentified OOM kill beats a finished load', () => {
  assert.equal(classify({ ...base, oomKills: 1, killedTypes: [], interactive: true }).rule, 2);
});

test('precedence 3>4: a positively interactive load beats refusal text', () => {
  const r = classify({ ...base, interactive: true, notices: [REFUSAL_TEXT] });
  assert.equal(r.outcome, 'loaded');
  assert.equal(r.rule, 3);
});

test('precedence 4>5: the refusal beats the generic load error it also is', () => {
  const r = classify({ ...base, storeError: `Failed to load "x.ifc": ${REFUSAL_TEXT}` });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.rule, 4);
});

test('precedence 5>6: a load error beats cancelled', () => {
  const r = classify({ ...base, storeError: OOM_TEXT, warningShown: true, decision: 'cancel' });
  assert.equal(r.outcome, 'error');
  assert.equal(r.rule, 5);
});

test('precedence 5>7 (review on #10415): a load error with the warning still on screen is error, never awaiting-decision', () => {
  const r = classify({ ...base, storeError: OOM_TEXT, warningShown: true });
  assert.equal(r.outcome, 'error');
  assert.equal(verdict(r.outcome, 'not-killed').pass, false);
  // The OOM text only in an error card (row 6) also beats the warning states.
  assert.equal(classify({ ...base, notices: [OOM_TEXT], warningShown: true }).outcome, 'error');
});

test('precedence 6>7: cancelled beats awaiting-decision', () => {
  const r = classify({ ...base, warningShown: true, decision: 'cancel' });
  assert.equal(r.outcome, 'cancelled');
  assert.equal(r.rule, 7);
});

test('precedence 7>8: awaiting-decision beats timeout', () => {
  const r = classify({ ...base, warningShown: true, timedOut: true });
  assert.equal(r.outcome, 'awaiting-decision');
  assert.equal(r.rule, 8);
});

test('precedence 8>9: timeout beats no verdict, and nothing observed is error', () => {
  assert.equal(classify({ ...base, timedOut: true }).rule, 9);
  const none = classify(base);
  assert.equal(none.outcome, 'error');
  assert.equal(none.rule, 10);
});

test('precedence: a load error beats loaded only when the load was not interactive', () => {
  assert.equal(classify({ ...base, storeError: OOM_TEXT, interactive: true }).outcome, 'loaded');
  assert.equal(classify({ ...base, storeError: OOM_TEXT, interactive: false }).outcome, 'error');
});

test('precedence 2 (review on #10415): two OOM kills with one identified GPU victim is error, even when interactive', () => {
  const r = classify({ ...base, oomKills: 2, killedTypes: ['gpu-process'], interactive: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.rule, 2);
  assert.match(r.reason, /1 kill\(s\) whose victim was not identified \(identified: gpu-process\)/);
  for (const e of ['killed', 'not-killed', 'warned', 'loaded']) assert.equal(verdict(r.outcome, e).pass, false);
  // Every kill accounted for by a non-tab victim: the live, interactive load is loaded with a note.
  assert.equal(classify({ ...base, oomKills: 2, killedTypes: ['gpu-process', 'utility'], interactive: true }).outcome, 'loaded');
  // 1>2 still holds: a crashed page is killed even if another kill is unidentified; without tab
  // evidence an unidentified kill is error, never killed.
  assert.equal(classify({ ...base, oomKills: 3, killedTypes: ['gpu-process', 'renderer'], pageCrashed: true }).outcome, 'killed');
  assert.equal(classify({ ...base, oomKills: 3, killedTypes: ['gpu-process', 'renderer'] }).outcome, 'error');
});

test('final snapshot (review on #10415): an explicit refusal replaces the poll\'s generic model error', async () => {
  const { mergeFinalSnapshot, GENERIC_MODEL_ERROR } = lib();
  const polled = { ...base, storeError: GENERIC_MODEL_ERROR };
  const refusal = `Failed to load "x.ifc": ${REFUSAL_TEXT}`;
  const merged = mergeFinalSnapshot(polled, { error: refusal, modelStates: ['error'], warningVisible: false, notices: [] });
  assert.equal(merged.storeError, refusal);
  assert.equal(classify(merged).outcome, 'refused');
  // A later generic placeholder never replaces a specific earlier error.
  assert.equal(mergeFinalSnapshot({ ...base, storeError: OOM_TEXT }, { error: null, modelStates: ['error'], notices: [] }).storeError, OOM_TEXT);
  // Two different specific errors are both kept; the precedence table decides (refusal row 4 beats error row 5).
  const both = mergeFinalSnapshot({ ...base, storeError: OOM_TEXT }, { error: refusal, modelStates: ['error'], notices: [] });
  assert.equal(both.storeError, OOM_TEXT);
  assert.deepEqual(both.otherErrors, [refusal]);
  assert.equal(classify(both).outcome, 'refused');
  // The same message twice is not duplicated.
  assert.equal(mergeFinalSnapshot({ ...base, storeError: OOM_TEXT }, { error: OOM_TEXT, modelStates: [], notices: [] }).otherErrors, undefined);
});

test('#10353 server proof: a request between the driver call and the real pick is startup, after the pick it is the attempt (review on #10415)', async () => {
  const { serverAttemptSummary } = serverApi();
  const dialog = { ms: 60, event: 'dialog', text: 'This model may exceed available memory' };
  // Times are relative to the page's pick stamp; the request at -5 ms happened while the pick was pending.
  const pending = serverAttemptSummary([{ ms: -5, event: 'request', clock: 'page' }, dialog], { watching: true, tracker: withRequests({ before: [-5] }) });
  assert.equal(pending.attempts, 0);
  assert.deepEqual(pending.startupRequests, { count: 1, ms: [-5] });
  assert.equal(pending.attemptBeforeDecision, false);
  const after = serverAttemptSummary([{ ms: -5, event: 'request', clock: 'page' }, { ms: 20, event: 'request', clock: 'page' }, dialog], { watching: true, tracker: withRequests({ before: [-5], after: [20] }) });
  assert.equal(after.firstAttemptMs, 20);
  assert.equal(after.attemptBeforeDecision, true);
});

test('#10353 server proof: unknown pick time or driver-only requests make the order null', async () => {
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const dialog = { ms: 60, event: 'dialog', text: 'This model may exceed available memory' };
  const noPick = serverAttemptSummary([{ ms: 20, event: 'request', clock: 'page' }, dialog], { watching: true, tracker: facts({}, { pickKnown: false }) });
  for (const k of ['attemptBeforeDecision', 'readBeforeDecision', 'unattributedReadBeforeDecision', 'sourcePostBeforeDecision']) assert.equal(noPick[k], null, k);
  assert.match(noPick.unknownBecause.order, /never stamped the file pick/);
  assert.equal(expectFlags(noPick, SERVER_FIRST).pass, false);
  const driverOnly = serverAttemptSummary([{ ms: 20, event: 'driver-request', clock: 'driver' }, { ms: 21, event: 'driver-requestfailed', failure: 'net::ERR_CONNECTION_REFUSED' }, dialog], { watching: true, tracker: facts() });
  assert.equal(driverOnly.attemptBeforeDecision, null);
  assert.equal(driverOnly.failureCode, 'net::ERR_CONNECTION_REFUSED');
  assert.match(driverOnly.unknownBecause.attemptBeforeDecision, /only by the driver/);
});

test('#10353 server proof: the attempt and request counts survive a log filled by 50 startup requests (review on #10415)', async (t) => {
  const { installSourceTracker, trackerSummary } = trackerApi();
  const { serverAttemptSummary, expectFlags, SERVER_FIRST } = serverApi();
  const saved = Object.fromEntries(['arrayBuffer', 'text', 'bytes', 'stream', 'slice'].map((m) => [m, Blob.prototype[m]]));
  t.after(() => { for (const [m, f] of Object.entries(saved)) Blob.prototype[m] = f; });
  let clock = 0;
  const target = { location: { href: 'http://127.0.0.1:5173/' }, fetch: () => Promise.reject(new TypeError('Failed to fetch')) };
  // Detailed log keeps only the first 10 and last 10 events per kind.
  const tracker = installSourceTracker({ Blob, target, now: () => clock, watchOrigin: 'http://127.0.0.1:49159', keepEvents: 10 });
  for (let i = 0; i < 50; i++) { clock = i; target.fetch('http://127.0.0.1:49159/api/v1/health').catch(() => {}); }
  clock = 100; tracker.markSource(new Blob([new Uint8Array(4)]));
  clock = 130; await target.fetch('http://127.0.0.1:49159/api/v1/health').catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  const tr = trackerSummary(tracker.report(), 90);
  assert.equal(tr.truncated, true, 'the detailed log overflowed');
  assert.equal(tr.requestsBeforePick, 50);
  assert.equal(tr.requestsAfterPick, 1);
  assert.equal(tr.facts.firstRequestAfterPick.ms, 30);
  const timeline = [...tr.events, { ms: 60, event: 'dialog', text: 'This model may exceed available memory' }];
  const v = serverAttemptSummary(timeline, { watching: true, tracker: tr });
  assert.equal(v.attempts, 1);
  assert.equal(v.startupRequests.count, 50);
  assert.equal(v.firstAttemptMs, 30);
  assert.equal(v.attemptBeforeDecision, true);
  assert.equal(expectFlags(v, SERVER_FIRST).pass, true);
});

test('OOM accounting per event (review on #10415): an extra vanished process in one interval cannot cover a missing victim in another', async () => {
  const { oomAccounting } = lib();
  // Interval A: one kill, two processes vanished (one was a normal exit). Interval B: one kill, nothing vanished.
  const events = [{ added: 1, types: ['gpu-process', 'utility'] }, { added: 1, types: [] }];
  assert.equal(oomAccounting(events, 2).unidentified, 1, 'the aggregate count (2 kills, 2 types) would have hidden it');
  const r = classify({ ...base, oomKills: 2, killEvents: events, killedTypes: ['gpu-process', 'utility'], interactive: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.rule, 2);
  assert.equal(verdict(r.outcome, 'not-killed').pass, false);
});

test('OOM accounting per event: two kills in one interval with one vanished process leave one unidentified', async () => {
  const { oomAccounting } = lib();
  assert.equal(oomAccounting([{ added: 2, types: ['gpu-process'] }], 2).unidentified, 1);
  assert.equal(classify({ ...base, oomKills: 2, killEvents: [{ added: 2, types: ['gpu-process'] }], interactive: true }).outcome, 'error');
});

test('OOM accounting per event: the same process type killed twice in two intervals is fully identified', async () => {
  const { oomAccounting } = lib();
  const events = [{ added: 1, types: ['gpu-process'] }, { added: 1, types: ['gpu-process'] }];
  assert.deepEqual(oomAccounting(events, 2), { kills: 2, types: ['gpu-process', 'gpu-process'], unidentified: 0, ambiguous: 0 });
  const r = classify({ ...base, oomKills: 2, killEvents: events, interactive: true });
  assert.equal(r.outcome, 'loaded');
  assert.match(r.reason, /OOM-killed gpu-process\+gpu-process \(not the tab\)/);
});

test('OOM accounting per event: kills the sampler never saw (counter read only at the end) are unidentified', async () => {
  const { oomAccounting } = lib();
  assert.equal(oomAccounting([{ added: 1, types: ['gpu-process'] }], 3).unidentified, 2);
  assert.equal(classify({ ...base, oomKills: 1, killEvents: [], interactive: true }).outcome, 'error');
  // A crashed page is a tab death (row 1 beats row 2); a vanished renderer type alone is not.
  assert.equal(classify({ ...base, pageCrashed: true, oomKills: 2, killEvents: [{ added: 1, types: ['renderer'] }, { added: 1, types: [] }] }).outcome, 'killed');
  assert.equal(classify({ ...base, oomKills: 2, killEvents: [{ added: 1, types: ['renderer'] }, { added: 1, types: [] }] }).outcome, 'error');
});

test('withTimeout (review on #10415): a fallback that throws rejects, so cleanup records it and runs the remaining steps', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 10, () => { throw new Error('systemctl stop failed'); }), /systemctl stop failed/);
  await assert.rejects(withTimeout(new Promise(() => {}), 10, () => Promise.reject(new Error('async fallback failed'))), /async fallback failed/);
  const ran = [];
  const failures = await runCleanup([
    { name: 'fixture', fn: () => ran.push('fixture') },
    { name: 'browser', fn: () => withTimeout(new Promise(() => {}), 10, () => { throw new Error('systemctl stop failed'); }) },
  ]);
  assert.deepEqual(ran, ['fixture'], 'the step after the failing fallback still ran');
  assert.deepEqual(failures, ['browser: systemctl stop failed']);
});

test('tab evidence (review on #10415): a GPU kill and an unrelated renderer exiting in one interval leave an interactive tab loaded, with a note', () => {
  const r = classify({ ...base, oomKills: 1, killEvents: [{ added: 1, types: ['gpu-process', 'renderer'] }], interactive: true });
  assert.equal(r.outcome, 'loaded');
  assert.equal(r.rule, 3);
  assert.match(r.reason, /1 interval\(s\) with more vanished processes than kills \(victim ambiguous\)/);
  assert.equal(verdict(r.outcome, 'killed').pass, false, '--expect killed must not pass for a tab that stayed interactive');
});

test('tab evidence: this page\'s renderer crashing is killed', () => {
  const r = classify({ ...base, oomKills: 1, killEvents: [{ added: 1, types: ['renderer'] }], pageCrashed: true });
  assert.equal(r.outcome, 'killed');
  assert.equal(r.rule, 1);
  assert.equal(classify({ ...base, pageClosed: true }).outcome, 'killed');
});

test('tab evidence: a kill with no vanished process and an alive interactive tab is error, as before', () => {
  const r = classify({ ...base, oomKills: 1, killEvents: [{ added: 1, types: [] }], interactive: true });
  assert.equal(r.outcome, 'error');
  assert.equal(r.rule, 2);
});

test('TAB_ALIVE_INVARIANT: no kill accounting makes an alive, interactive tab killed', () => {
  const typeSets = [[], ['renderer'], ['browser'], ['gpu-process'], ['renderer', 'renderer'], ['gpu-process', 'renderer', 'utility']];
  for (const types of typeSets) {
    for (const added of [1, 2, 3]) {
      const r = classify({ ...base, oomKills: added, killEvents: [{ added, types }], killedTypes: types, interactive: true });
      assert.notEqual(r.outcome, 'killed', `${added} kill(s), vanished ${types.join('+') || 'none'}`);
      assert.ok(['loaded', 'error'].includes(r.outcome));
    }
  }
});

test('#10264 S0 cpuGeometrySummary: MiB per holder, bytes per triangle, null without the hook', () => {
  const summary = lib().cpuGeometrySummary;
  assert.equal(typeof summary, 'function', 'cpuGeometrySummary must exist');
  assert.equal(summary(null, 10), null);
  assert.equal(summary(undefined, 10), null);
  const MiB = 2 ** 20;
  const s = summary({ totalBytes: 84 * MiB, buffers: 3, sharedBytes: 84 * MiB, walkMs: 12.4,
    byKind: { positions: 36 * MiB, normals: 36 * MiB, indices: 12 * MiB, other: 0 },
    owners: { 'store.models': { reachableBytes: 84 * MiB, exclusiveBytes: 0 }, 'scene.buckets': { reachableBytes: 84 * MiB, exclusiveBytes: 0 } } }, MiB);
  assert.equal(s.totalMiB, 84);
  assert.equal(s.bytesPerTriangle, 84);
  assert.deepEqual(s.owners['scene.buckets'], { reachableMiB: 84, exclusiveMiB: 0 });
  assert.equal(s.byKindMiB.normals, 36);
  assert.equal(s.walkMs, 12);
  assert.equal(summary({ totalBytes: 0, owners: {} }, 0).bytesPerTriangle, null);
});


test('#10506 CPU geometry sampling distinguishes missing, failed and timed-out hooks', async () => {
  const { sampleCpuGeometry } = lib();
  assert.deepEqual(await sampleCpuGeometry(() => null, 0, 100), { status: 'unavailable' });
  assert.deepEqual(await sampleCpuGeometry(() => { throw new Error('broken walk'); }, 0, 100), { status: 'error', error: 'broken walk' });
  assert.deepEqual(await sampleCpuGeometry(() => Promise.reject(new Error('rejected walk')), 0, 100), { status: 'error', error: 'rejected walk' });
  assert.deepEqual(await sampleCpuGeometry(() => new Promise(() => {}), 0, 5), { status: 'timeout' });
  assert.equal((await sampleCpuGeometry(() => ({}), 0, 100)).status, 'error');
  const measured = await sampleCpuGeometry(() => ({ totalBytes: 84, buffers: 3, owners: {}, triangles: 1 }), 100, 100);
  assert.equal(measured.status, 'available');
  assert.equal(measured.held.totalBytes, 84);
  assert.equal(measured.held.bytesPerTriangle, 84);
});
