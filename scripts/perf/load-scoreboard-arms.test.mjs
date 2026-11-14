/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Opt-in arms beside the default lanes (review #9744): the defaults stay main's,
// the boot signal is read strictly and re-checked at the arm, a protocol mismatch
// between sides is visible and never a verdict, captions name every lane's clock,
// and the arm wiring in browserSample / the run loop is exercised end to end with
// a fake browser (load-scoreboard-fake-browser.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LANES, LANES, clockOrigins, elementsFileFor, renderMarkdown, summarize } from './load-scoreboard-report.mjs';
import { loadPlan, recordArmLanes } from './load-scoreboard.mjs';
import { armAfterBootSettled, readBootSignal, waitBootSettled } from './viewer-load-boot.mjs';
import { browserSample } from './load-scoreboard-browser.mjs';
import { fakeBrowserSample } from './load-scoreboard-fake-browser.mjs';

function withPlanDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'arms-plan-'));
  writeFileSync(join(dir, 'index.html'), '');
  const plan = (extra) => {
    const p = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify({ rounds: 1, fixtures: [{ name: 'f', path: process.execPath }],
      sides: { base: { label: 'a', dist: dir, perfProbe: process.execPath }, branch: { label: 'b', dist: dir, perfProbe: process.execPath } }, ...extra }));
    return loadPlan(p);
  };
  try { return fn(plan); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a plan without `lanes` runs exactly the lanes main ran; the opt-in arms only when named', () => {
  assert.deepEqual(DEFAULT_LANES, ['native-cold', 'browser-cold', 'browser-cold-early', 'browser-warm1', 'browser-warm', 'boot']);
  withPlanDir((plan) => {
    assert.deepEqual(plan({}).lanes, DEFAULT_LANES);
    assert.equal(plan({}).warmOpens, 2);
  });
  for (const lane of LANES.filter((l) => !DEFAULT_LANES.includes(l))) assert.match(lane, /-(early|settled)$/);
});

test('the reopen count follows the lanes named: main\'s rule for the defaults, two for an arm\'s warm lane', () => {
  withPlanDir((plan) => {
    assert.equal(plan({ lanes: ['browser-cold'] }).warmOpens, 0);
    assert.equal(plan({ lanes: ['browser-warm'] }).warmOpens, 2);
    assert.equal(plan({ lanes: ['browser-warm1'] }).warmOpens, 0, 'main: only browser-warm implies reopens');
    assert.equal(plan({ lanes: ['browser-cold-early'] }).warmOpens, 0);
    assert.equal(plan({ lanes: ['browser-warm-settled'] }).warmOpens, 2);
    assert.equal(plan({ lanes: ['browser-warm-early'] }).warmOpens, 2);
    assert.equal(plan({ lanes: ['browser-warm-settled'], warmOpens: 1 }).warmOpens, 1);
  });
});

test('the boot signal must be a synchronous boolean: a Promise, a string or a number is a failure naming its type', async () => {
  const cases = [[async () => true, 'Promise'], [() => 'pending', 'string'], [() => 1, 'number'], [() => null, 'null']];
  const saved = globalThis.__ifc_lite_boot_settled__;
  try {
    for (const [hook, type] of cases) {
      globalThis.__ifc_lite_boot_settled__ = hook;
      assert.deepEqual(readBootSignal(), { kind: 'invalid', type });
      const page = { evaluate: async (fn) => fn(), waitForTimeout: async () => {} };
      await assert.rejects(waitBootSettled(page), new RegExp(`returned ${type}, not a boolean`));
    }
    globalThis.__ifc_lite_boot_settled__ = () => true;
    assert.deepEqual(readBootSignal(), { kind: 'boolean', value: true });
  } finally {
    if (saved === undefined) delete globalThis.__ifc_lite_boot_settled__; else globalThis.__ifc_lite_boot_settled__ = saved;
  }
});

test('the signal is read again at the arm: boot work that restarted during the quiet wait fails the sample', async () => {
  const saved = { hook: globalThis.__ifc_lite_boot_settled__, tasks: globalThis.__benchLongTasks };
  let calls = 0;
  globalThis.__ifc_lite_boot_settled__ = () => ++calls === 1; // settled, then pending again
  globalThis.__benchLongTasks = [];
  const page = { evaluate: async (fn, arg) => fn(arg), waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)) };
  try {
    await assert.rejects(armAfterBootSettled(page), /signal was false at the arm/);
    calls = 0;
    globalThis.__ifc_lite_boot_settled__ = () => { calls++; return true; };
    const shell = await armAfterBootSettled(page);
    assert.equal(shell.bootSettled, true);
    assert.equal(shell.bootSettledAtArm, true);
    assert.equal(calls, 2);
  } finally {
    if (saved.hook === undefined) delete globalThis.__ifc_lite_boot_settled__; else globalThis.__ifc_lite_boot_settled__ = saved.hook;
    globalThis.__benchLongTasks = saved.tasks;
  }
});

test('browserSample wiring: the default arm never consults the signal; -settled fails without it or arms after it', async () => {
  // Default arm, signal present: armed on the quiet shell, the hook untouched (the open then fails in the fake).
  const quiet = await fakeBrowserSample(browserSample, { arm: 'quiet', hook: () => false });
  assert.equal(quiet.hookCalls, 0);
  assert.match(quiet.result.lanes['browser-cold'].error, /^cold: /);
  // boot-settled, no hook, no declaration: the sample fails at the arm and records its lane as failed.
  const missing = await fakeBrowserSample(browserSample, { arm: 'boot-settled' });
  assert.equal(missing.result.lanes['browser-cold-settled'].ok, false);
  assert.match(missing.result.lanes['browser-cold-settled'].error, /^cold-shell: boot-settled arm: the page exposes no/);
  // boot-settled, no hook, side declares bootSignal: false: armed on the quiet shell.
  const declared = await fakeBrowserSample(browserSample, { arm: 'boot-settled', side: { bootSignal: false } });
  assert.match(declared.result.lanes['browser-cold-settled'].error, /^cold: /);
  // boot-settled, hook settled: armed after the signal, read again at the arm.
  const settled = await fakeBrowserSample(browserSample, { arm: 'boot-settled', hook: () => true });
  assert.match(settled.result.lanes['browser-cold-settled'].error, /^cold: /);
  assert.equal(settled.hookCalls, 2);
  // A declared-absent side whose page has the hook fails: a mislabelled build cannot pass.
  const mislabelled = await fakeBrowserSample(browserSample, { arm: 'boot-settled', hook: () => true, side: { bootSignal: false } });
  assert.match(mislabelled.result.lanes['browser-cold-settled'].error, /^cold-shell: .*declares `bootSignal: false`/);
});

/** A stand-in for browser.sample that writes element files the way browserSample does (`<tag>-<open>`). */
function stubSample(traces, { warmOk = true } = {}) {
  return async ({ tag, warmOpens }) => {
    writeFileSync(join(traces, `${tag}-cold.elements.json`), `"${tag} cold"`);
    const opens = warmOk ? warmOpens : Math.min(1, warmOpens);
    for (let i = 1; i <= opens; i++) writeFileSync(join(traces, `${tag}-warm${i}.elements.json`), `"${tag} warm${i}"`);
    const suffix = tag.match(/-(early|settled)$/)[0];
    const lanes = { [`browser-cold${suffix}`]: { ok: true } };
    if (warmOpens > 1) lanes[`browser-warm1${suffix}`] = { ok: true };
    if (warmOpens > 0) lanes[`browser-warm${suffix}`] = warmOk ? { ok: true } : { ok: false, error: 'warm2: failed' };
    return { lanes, warmOpens: Array.from({ length: opens }, () => ({})), meta: { adapter: null, pageErrors: [] } };
  };
}

test('run-loop wiring: arm files land where the report reads them; a resume or failed rerun never overwrites a recorded file', async () => {
  const out = mkdtempSync(join(tmpdir(), 'arms-loop-'));
  const traces = join(out, 'traces');
  mkdirSync(traces);
  try {
    const plan = { warmOpens: 2, sides: { base: { label: 'a' } } };
    const groupLanes = ['browser-cold-early', 'browser-warm1-early', 'browser-warm-early', 'browser-cold-settled'];
    const cell = { group: 'browser', fixture: 'FZK', round: 0, side: 'base' };
    const rows = [];
    const base = { plan, side: 'base', fixture: { name: 'FZK' }, cell, groupLanes, tag: 'FZK-base-r0', common: cell, record: (r) => rows.push(r), traces };
    // A fresh cell: every arm lane recorded, each file where elementsFileFor says the report will read it.
    await recordArmLanes({ ...base, sample: stubSample(traces), missing: groupLanes });
    assert.deepEqual(rows.map((r) => r.lane).sort(), [...groupLanes].sort());
    for (const r of rows) assert.ok(existsSync(join(traces, elementsFileFor(r))), elementsFileFor(r));
    // Resume: the early reopens are missing again; the recorded early-cold file must survive the rerun.
    writeFileSync(join(traces, 'FZK-base-r0-early-cold.elements.json'), '"RECORDED cold"');
    rows.length = 0;
    await recordArmLanes({ ...base, sample: stubSample(traces), missing: ['browser-warm1-early', 'browser-warm-early'] });
    assert.equal(readFileSync(join(traces, 'FZK-base-r0-early-cold.elements.json'), 'utf8'), '"RECORDED cold"');
    for (const r of rows) assert.match(readFileSync(join(traces, elementsFileFor(r)), 'utf8'), /-resume/);
    // A rerun whose last reopen fails after one reopen claims nothing: the recorded early-warm1 file stays.
    writeFileSync(join(traces, 'FZK-base-r0-early-warm1.elements.json'), '"RECORDED warm1"');
    rows.length = 0;
    await recordArmLanes({ ...base, sample: stubSample(traces, { warmOk: false }), missing: ['browser-warm-early'] });
    assert.equal(rows[0].ok, false);
    assert.equal(readFileSync(join(traces, 'FZK-base-r0-early-warm1.elements.json'), 'utf8'), '"RECORDED warm1"');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

/** -settled rows: same timings on both sides, protocol per side from `shell.bootSettled`. */
function settledRows(baseSignal, branchSignal) {
  return [0, 1, 2, 3, 4].flatMap((round) => [['base', baseSignal, 1000], ['branch', branchSignal, 700]].map(([side, signal, ms]) => ({
    lane: 'browser-cold-settled', fixture: 'fx', round, side, ok: true, interactiveMs: ms + round, fingerprint: 'm=1',
    shell: { bootSettled: signal, bootSettledWaitMs: signal === true ? 1500 : 0 } })));
}

test('a -settled compare whose sides armed differently is marked and inconclusive unless the plan declares it', () => {
  const plan = { name: 't', kind: 'compare', lanes: ['browser-cold-settled'], fixtures: [{ name: 'fx', set: 'tuning', bytes: 1 }],
    sides: { base: { label: 'main' }, branch: { label: 'pr' } }, rounds: 5, warmOpens: 0 };
  const floors = { fx: { 'browser-cold-settled': { interactiveMs: 0.05 } } };
  const mixed = summarize(plan, settledRows('no signal (declared)', true), { floors }).fixtures[0].lanes['browser-cold-settled'];
  assert.equal(mixed.armProtocol.same, false);
  assert.match(mixed.primary.verdict, /^inconclusive: arming protocols differ \(base: no signal \(declared\), branch: true/);
  assert.equal(mixed.primary.pass, false);
  const declared = summarize({ ...plan, asymmetricBootSignal: true }, settledRows('no signal (declared)', true), { floors }).fixtures[0].lanes['browser-cold-settled'];
  assert.doesNotMatch(declared.primary.verdict, /arming protocols differ/);
  const same = summarize(plan, settledRows(true, true), { floors }).fixtures[0].lanes['browser-cold-settled'];
  assert.equal(same.armProtocol.same, true);
  const md = renderMarkdown(summarize(plan, settledRows('no signal (declared)', true), { floors }), plan, { segments: [] });
  assert.match(md, /## Arm protocol/);
  assert.match(md, /\| fx \| browser-cold-settled \| no signal \(declared\); signal wait 0 ms \| true; signal wait 1,500 ms \| DIFFERENT: verdict inconclusive \|/);
});

test('every browser lane a plan names gets its clock origin in the caption; the signal wait is stated as untimed', () => {
  const caption = clockOrigins(LANES);
  for (const lane of LANES.filter((l) => l.startsWith('browser'))) assert.ok(caption.includes(lane), `${lane} has no stated clock origin`);
  assert.match(caption, /the wait for that signal is not timed/);
  assert.match(clockOrigins(['browser-warm1-early']), /first paint of that open's page/);
});

test('the first-reopen snapshot note covers every first-reopen lane', () => {
  for (const lane of ['browser-warm1', 'browser-warm1-early', 'browser-warm1-settled']) {
    const plan = { name: 't', kind: 'compare', lanes: [lane], fixtures: [{ name: 'fx', set: 'tuning', bytes: 2 ** 30 }],
      sides: { base: { label: 'a' }, branch: { label: 'b' } }, rounds: 1, warmOpens: 2 };
    const rows = ['base', 'branch'].map((side) => ({ lane, fixture: 'fx', round: 0, side, ok: true, interactiveMs: 1, fingerprint: 'm=1',
      cacheTiers: ['full'], loadPaths: ['cache'], snapshotPresentBeforeOpen: true, shell: { bootSettled: true } }));
    assert.match(renderMarkdown(summarize(plan, rows), plan, { segments: [] }), /stored before open 1\/1/, lane);
  }
});
