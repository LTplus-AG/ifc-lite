/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #10264: the capped load test is a known-issue test. Its verdict must not be
// able to pass silently: a kill is never a pass in acceptance mode, and in
// known-issue mode the fix landing (loaded/refused) fails until the flag flips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, optionErrors, parseSize, phaseOf, runCleanup, verdict, withTimeout } from './oom-load-probe-lib.mjs';

test('#10264 a tab death wins over every other signal', () => {
  assert.equal(classify({ oomKills: 1, killedTypes: ['renderer'], interactive: true }).outcome, 'killed');
  assert.equal(classify({ oomKills: 2, killedTypes: ['renderer'], storeError: 'Ran out of memory while processing x' }).outcome, 'killed');
  assert.equal(classify({ pageCrashed: true }).outcome, 'killed');
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

test('#10264 an OOM kill of the renderer or browser is `killed` at once', () => {
  assert.equal(classify({ oomKills: 1, killedTypes: ['renderer'], interactive: true }).outcome, 'killed');
  assert.equal(classify({ oomKills: 1, killedTypes: ['browser'] }).outcome, 'killed');
  assert.match(classify({ oomKills: 1, killedTypes: ['renderer'] }).reason, /renderer OOM-killed \(cgroup oom_kill=1\)/);
  assert.equal(classify({ pageCrashed: true }).outcome, 'killed');
});

test('#10264 GPU-only OOM kill, then the load finishes: `loaded` with a note', () => {
  const r = classify({ oomKills: 1, killedTypes: ['gpu-process'], interactive: true });
  assert.equal(r.outcome, 'loaded');
  assert.match(r.reason, /OOM-killed gpu-process \(not the tab\)/);
  assert.equal(verdict(r.outcome, 'killed').pass, false);
});

test('#10264 GPU-only OOM kill, then the renderer dies: `killed`', () => {
  assert.equal(classify({ oomKills: 2, killedTypes: ['gpu-process', 'renderer'] }).outcome, 'killed');
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
    assert.match(r.reason, /could not tell which process died/);
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
  assert.equal(classify({ warningShown: true, decision: 'continue', oomKills: 1, killedTypes: ['renderer'] }).outcome, 'killed-after-continue');
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

test('#10353 server proof: a failed server attempt before the warning, no read before it', async () => {
  const { serverAttemptSummary } = await import('./oom-load-probe-lib.mjs');
  const s = serverAttemptSummary([
    { ms: 40, event: 'request', url: 'http://127.0.0.1:9/api/v1/health' },
    { ms: 42, event: 'requestfailed', failure: 'net::ERR_CONNECTION_REFUSED' },
    { ms: 60, event: 'dialog', text: 'This model may exceed available memory\nThis model may need about 6.0 GiB' },
  ], { watching: true });
  assert.deepEqual(s, { watched: true, attempts: 1, failures: 1, firstAttemptMs: 40, firstDecisionMs: 60, attemptBeforeDecision: true, readBeforeDecision: false });
});

test('#10353 server proof: a read or a missing attempt before the decision is reported, unobserved is null', async () => {
  const { serverAttemptSummary } = await import('./oom-load-probe-lib.mjs');
  const late = serverAttemptSummary([
    { ms: 10, event: 'first-read' },
    { ms: 50, event: 'store-error', text: "This IFC file exceeds this tab's local processing memory budget" },
    { ms: 70, event: 'request', url: 'http://127.0.0.1:9/api/v1/health' },
  ], { watching: true });
  assert.equal(late.attemptBeforeDecision, false);
  assert.equal(late.readBeforeDecision, true);
  const none = serverAttemptSummary([{ ms: 5, event: 'dialog', text: 'This model may exceed available memory' }], { watching: true });
  assert.equal(none.attempts, 0);
  assert.equal(none.attemptBeforeDecision, null, 'no attempt observed is unknown order, not a pass');
  assert.equal(serverAttemptSummary([], { watching: false }).attemptBeforeDecision, null);
  // A privacy banner or other dialog is not the decision.
  assert.equal(serverAttemptSummary([{ ms: 1, event: 'dialog', text: 'IFClite stores an action log' }], { watching: true }).firstDecisionMs, null);
});
