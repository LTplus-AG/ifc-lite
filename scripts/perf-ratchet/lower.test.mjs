// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// #6959: lowering never raises, and the CLI's exit codes keep a ceiling
// breach (1) apart from a harness fault (2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function load(rel) {
  const url = new URL(rel, import.meta.url);
  return existsSync(url) ? import(url.href) : null;
}
const lower = await load('./lower.mjs');
const CLI = fileURLToPath(new URL('./perf-ratchet.mjs', import.meta.url));
function rt(name, body) {
  test(name, () => {
    // Checked before any spawn, so a missing CLI fails here as an assertion.
    assert.ok(lower && existsSync(CLI), 'the perf-ratchet modules are absent');
    return body();
  });
}

const OLD = { commit: 'abcdef1234567', measuredAt: '2026-10-01T00:00:00.000Z' };
const ceilingFile = () => ({
  family: 'bundle',
  description: 'test family',
  entries: [
    { id: 'wasm', metric: 'brotli-bytes', unit: 'bytes', ceiling: 1000, tolerance: { kind: 'relative', value: 0.005 }, provenance: OLD },
    { id: 'chunks', metric: 'count', ceiling: 7, tolerance: { kind: 'exact', value: 0 }, provenance: OLD },
    { id: 'noise', metric: 'brotli-bytes', ceiling: 1000, tolerance: { kind: 'relative', value: 0.005 }, provenance: OLD },
  ],
});
const measurement = (values) => ({
  family: 'bundle',
  commit: 'f00dfeed12345',
  measuredAt: '2026-10-05T00:00:00.000Z',
  metrics: Object.entries(values).map(([id, value]) => ({ id, value })),
});

rt('lowers entries that cleared their band to the measured value and re-stamps provenance', () => {
  const { next, changes } = lower.lowerFamily(ceilingFile(), measurement({ wasm: 900, chunks: 6, noise: 998 }));
  const byId = Object.fromEntries(next.entries.map((e) => [e.id, e]));
  assert.equal(byId.wasm.ceiling, 900);
  assert.deepEqual(byId.wasm.provenance, { commit: 'f00dfeed12345', measuredAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(byId.chunks.ceiling, 6);
  assert.equal(byId.noise.ceiling, 1000, 'a 0.2% wobble inside the band is not lowered');
  assert.deepEqual(byId.noise.provenance, OLD);
  assert.deepEqual(changes.map((c) => [c.id, c.from, c.to]), [['wasm', 1000, 900], ['chunks', 7, 6]]);
  assert.equal(next.description, 'test family', 'family-level fields survive');
});

rt('never raises: a measured rise leaves the ceiling exactly as committed', () => {
  const before = ceilingFile();
  const { next, changes } = lower.lowerFamily(before, measurement({ wasm: 5000, chunks: 9, noise: 1000 }));
  assert.deepEqual(next, ceilingFile());
  assert.deepEqual(changes, []);
});

rt('a ceiling with no measurement is left alone rather than lowered to nothing', () => {
  const { next } = lower.lowerFamily(ceilingFile(), measurement({ wasm: 1000 }));
  assert.deepEqual(next, ceilingFile());
});

rt('changelog lists each lowered metric old -> new', () => {
  const { changes } = lower.lowerFamily(ceilingFile(), measurement({ wasm: 900, chunks: 6, noise: 1000 }));
  const md = lower.formatChangelog([{ family: 'bundle', changes }], { commit: 'f00dfeed12345' });
  assert.match(md, /`bundle\/wasm`: 1,000 -> 900 bytes \(-10\.00%\)/);
  assert.match(md, /`bundle\/chunks`: 7 -> 6 \(-14\.29%\)/);
  assert.match(lower.formatChangelog([{ family: 'bundle', changes: [] }], { commit: 'x' }), /No ceiling lowered/);
});

function scratch(values) {
  const dir = mkdtempSync(join(tmpdir(), 'perf-ratchet-cli-'));
  mkdirSync(join(dir, 'ceilings'));
  writeFileSync(join(dir, 'ceilings', 'bundle.json'), `${JSON.stringify(ceilingFile(), null, 2)}\n`);
  writeFileSync(join(dir, 'measured.json'), JSON.stringify(measurement(values)));
  return dir;
}
function cli(dir, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, '--ceilings-dir', join(dir, 'ceilings')], { encoding: 'utf8', timeout: 20_000 });
}

rt('check exits 0 within ceilings, 1 on a breach, and writes the markdown report', () => {
  const dir = scratch({ wasm: 1004, chunks: 7, noise: 1000 });
  try {
    const ok = cli(dir, 'check', '--measured', join(dir, 'measured.json'), '--markdown', join(dir, 'r.md'));
    assert.equal(ok.status, 0);
    assert.match(readFileSync(join(dir, 'r.md'), 'utf8'), /all metrics within their ceilings/);

    writeFileSync(join(dir, 'measured.json'), JSON.stringify(measurement({ wasm: 1004, chunks: 8, noise: 1000 })));
    const bad = cli(dir, 'check', '--measured', join(dir, 'measured.json'));
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /`bundle\/chunks`.*FAIL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

rt('check exits 2 on a harness fault: no measurement, or no ceiling file for the family', () => {
  const dir = scratch({ wasm: 1 });
  try {
    assert.equal(cli(dir, 'check').status, 2);
    writeFileSync(join(dir, 'measured.json'), JSON.stringify({ ...measurement({ a: 1 }), family: 'copies' }));
    const r = cli(dir, 'check', '--measured', join(dir, 'measured.json'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no ceiling file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

rt('lower rewrites the ceiling file in place; --dry-run leaves it untouched', () => {
  const dir = scratch({ wasm: 900, chunks: 7, noise: 1000 });
  const file = join(dir, 'ceilings', 'bundle.json');
  try {
    const before = readFileSync(file, 'utf8');
    const dry = cli(dir, 'lower', '--measured', join(dir, 'measured.json'), '--dry-run');
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /`bundle\/wasm`: 1,000 -> 900/);
    assert.equal(readFileSync(file, 'utf8'), before);

    const real = cli(dir, 'lower', '--measured', join(dir, 'measured.json'), '--changelog', join(dir, 'c.md'));
    assert.equal(real.status, 0);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.entries.find((e) => e.id === 'wasm').ceiling, 900);
    assert.match(readFileSync(join(dir, 'c.md'), 'utf8'), /f00dfeed12345/);
    // Lowered ceilings now equal the measurement, so a re-check is clean.
    assert.equal(cli(dir, 'check', '--measured', join(dir, 'measured.json')).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
