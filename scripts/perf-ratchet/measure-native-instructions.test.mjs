// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6982: the native instruction-count measurer and its committed ceilings.
// The CLI runs as a child process, like the sibling perf-ratchet tests, so a
// missing module is an assertion failure and not a load error.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPTS = fileURLToPath(new URL('./', import.meta.url));
const CEILINGS_DIR = fileURLToPath(new URL('../../tests/perf-ratchets/', import.meta.url));
const MEASURER = join(SCRIPTS, 'measure-native-instructions.mjs');
const CLI = join(SCRIPTS, 'perf-ratchet.mjs');

async function load(rel) {
  const url = new URL(rel, import.meta.url);
  return existsSync(url) ? import(url.href) : null;
}
const measure = await load('./measure-native-instructions.mjs');
const ceilings = await load('./ceilings.mjs');
function rt(name, body) {
  test(name, () => {
    assert.ok(measure && ceilings, 'the native-instructions measurer is absent');
    return body();
  });
}

const REPORT = {
  fixture: 'tests/models/ara3d/AC20-FZK-Haus.ifc',
  phases: { parseIr: 100, entityScanIr: 60, lookupIr: 10, preprocessIr: 25, geometryIr: 360, totalIr: 470 },
};

rt('buildMeasured maps every phase to a <fixture>.<phase> metric and validates', () => {
  const m = measure.buildMeasured({ set: 'small', report: REPORT, commit: 'abc1234', measuredAt: '2026-10-06T00:00:00.000Z' });
  assert.deepEqual(ceilings.validateMeasuredFile(m), []);
  assert.equal(m.family, 'native-instructions');
  assert.deepEqual(Object.fromEntries(m.metrics.map((x) => [x.id, x.value])), {
    'fzk-haus.parse': 100,
    'fzk-haus.entity-scan': 60,
    'fzk-haus.lookup': 10,
    'fzk-haus.preprocess': 25,
    'fzk-haus.geometry': 360,
    'fzk-haus.total': 470,
  });
  assert.equal(measure.buildMeasured({ set: 'large', report: REPORT, commit: 'abc1234' }).family, 'native-instructions-large');
});

rt('buildMeasured refuses a zero, missing or unknown input instead of measuring nothing', () => {
  const bad = (phases) => ({ ...REPORT, phases });
  assert.throws(() => measure.buildMeasured({ set: 'small', report: bad({ ...REPORT.phases, lookupIr: 0 }), commit: 'a' }), /lookupIr/);
  assert.throws(() => measure.buildMeasured({ set: 'small', report: bad({ parseIr: 1 }), commit: 'a' }), /entityScanIr/);
  assert.throws(() => measure.buildMeasured({ set: 'small', report: {}, commit: 'a' }), /no `phases`/);
  assert.throws(() => measure.buildMeasured({ set: 'huge', report: REPORT, commit: 'a' }), /unknown --set/);
});

rt('the CLI exits 2 (harness fault) without --set or with a bad one', () => {
  for (const args of [[], ['--set', 'huge'], ['--bogus', 'x']]) {
    const r = spawnSync(process.execPath, [MEASURER, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `args ${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /measure-native-instructions:/);
  }
});

const load2 = (family) => ceilings.loadCeilingFile(join(CEILINGS_DIR, `${family}.json`));

rt('each committed family ratchets exactly the metrics its measurer emits, relative and tight', () => {
  for (const [set, def] of Object.entries(measure.SETS)) {
    const file = load2(def.family);
    assert.equal(file.family, def.family);
    const ids = measure.buildMeasured({ set, report: REPORT, commit: 'a' }).metrics.map((x) => x.id).sort();
    assert.deepEqual(file.entries.map((e) => e.id).sort(), ids);
    for (const e of file.entries) {
      assert.equal(e.tolerance.kind, 'relative');
      // Above the 1e-6 run-to-run variance, below the smallest change the
      // ledger cares about (~0.1%): the band is what a ceiling may sit under.
      assert.ok(e.tolerance.value > 1e-5 && e.tolerance.value <= 0.001, `${e.id} tolerance ${e.tolerance.value}`);
      assert.equal(e.fixture, def.fixture);
    }
  }
});

function check(family, mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'native-ir-'));
  try {
    const file = load2(family);
    const metrics = file.entries.map((e) => ({ id: e.id, value: mutate(e) }));
    const path = join(dir, `${family}.json`);
    writeFileSync(path, JSON.stringify({ family, commit: 'abc1234', measuredAt: '2026-10-06T00:00:00.000Z', metrics }));
    return spawnSync(process.execPath, [CLI, 'check', '--measured', path], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

rt('check passes at the ceiling and fails when one phase grows past ceiling + 0.05%', () => {
  const ok = check('native-instructions', (e) => e.ceiling);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const inside = check('native-instructions', (e) => (e.id === 'fzk-haus.geometry' ? Math.floor(e.ceiling * (1 + e.tolerance.value * 0.9)) : e.ceiling));
  assert.equal(inside.status, 0, 'inside the band passes');
  const breach = check('native-instructions', (e) => (e.id === 'fzk-haus.geometry' ? Math.ceil(e.ceiling * (1 + e.tolerance.value * 1.5)) : e.ceiling));
  assert.equal(breach.status, 1, breach.stdout + breach.stderr);
  assert.match(breach.stdout, /fzk-haus\.geometry/);
});

rt('a missing phase is a failure, never a skipped comparison', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-ir-'));
  try {
    const file = load2('native-instructions');
    const metrics = file.entries.slice(1).map((e) => ({ id: e.id, value: e.ceiling }));
    const path = join(dir, 'native-instructions.json');
    writeFileSync(path, JSON.stringify({ family: 'native-instructions', commit: 'abc1234', measuredAt: '2026-10-06T00:00:00.000Z', metrics }));
    const r = spawnSync(process.execPath, [CLI, 'check', '--measured', path], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
