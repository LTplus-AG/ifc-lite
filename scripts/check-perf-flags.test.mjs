/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The changed-test oracle removes newly added production files. Keep this test
// loadable in that state so a missing detector fails an assertion, not import.
const lint = await import('./lib/perf-flag-lint.mjs').catch(() => null);
const gate = await import('./check-perf-flags.mjs').catch(() => null);
const need = (mod, name) => {
  assert.ok(mod, `${name} must be available`);
  return mod;
};
const checkRegistry = (...args) => need(lint, 'perf-flag lint').checkRegistry(...args);
const findPerfGlobalReads = (...args) => need(lint, 'perf-flag lint').findPerfGlobalReads(...args);

const TODAY = new Date('2026-10-05T00:00:00Z');
const flag = (fields) => `{ ${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')}, bindings: { global: '__IFC_LITE_X' } }`;
const registry = (...entries) => `export const PERF_FLAGS = [\n${entries.join(',\n')}\n] as const satisfies readonly PerfFlagDefinition[];`;
const base = { id: 'lodPx', kind: 'kill-switch', owner: '@louistrue', removalCondition: 'after two releases', introducedAt: '2026-07-11', default: 48 };

test('a complete registry passes', () => {
  assert.deepEqual(checkRegistry(registry(flag(base), flag({ ...base, id: 'fresh', kind: 'ramp', introducedAt: '2026-09-20' })), { today: TODAY }), []);
});

test('a ramp more than four weeks old fails; an old kill switch does not', () => {
  const ok = checkRegistry(registry(flag({ ...base, id: 'edge', kind: 'ramp', introducedAt: '2026-09-07' })), { today: TODAY });
  assert.deepEqual(ok, [], '28 days is still inside the window');
  const problems = checkRegistry(registry(flag({ ...base, id: 'stale', kind: 'ramp', introducedAt: '2026-09-06' })), { today: TODAY });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /stale.*ramp is 29 days past introducedAt/);
  assert.deepEqual(checkRegistry(registry(flag({ ...base, introducedAt: '2025-01-01' })), { today: TODAY }), []);
});

test('missing owner or removal condition fails, for any kind', () => {
  const { owner: _o, ...noOwner } = base;
  assert.match(checkRegistry(registry(flag(noOwner)), { today: TODAY }).join('\n'), /missing owner/);
  assert.match(checkRegistry(registry(flag({ ...base, kind: 'ramp', introducedAt: '2026-10-01', removalCondition: '  ' })), { today: TODAY }).join('\n'), /missing removalCondition/);
});

test('bad kind, bad date, duplicate id and non-literal entries fail', () => {
  const problems = checkRegistry(registry(
    flag({ ...base, kind: 'experiment' }),
    flag({ ...base, id: 'b', introducedAt: 'last week' }),
    flag({ ...base, id: 'b' }),
    'SPREAD_FLAG',
  ), { today: TODAY }).join('\n');
  assert.match(problems, /kind must be/);
  assert.match(problems, /introducedAt must be an ISO date/);
  assert.match(problems, /\(b\): duplicate id/);
  assert.match(problems, /must be an object literal/);
});

test('a source with no PERF_FLAGS array is an error, not a silent pass', () => {
  assert.throws(() => checkRegistry('export const OTHER = [];'), /no `PERF_FLAGS`/);
});

test('global reads are found in every spelling, prose and comments are not', () => {
  const source = [
    'const a = (globalThis as { __IFC_LITE_LOD_PX?: unknown }).__IFC_LITE_LOD_PX;',
    "const b = (globalThis as Record<string, unknown>)['__IFC_LITE_CHUNKS'];",
    '// globalThis.__IFC_LITE_QUANTIZED = 0 is the kill switch',
    "console.warn('ignoring invalid __IFC_LITE_CHUNKS:', raw);",
    'const c = `__IFC_LITE_GPU_BUDGET_MB`;',
  ].join('\n');
  assert.deepEqual(findPerfGlobalReads(source, 'apps/viewer/src/x.ts'), [
    { line: 1, name: '__IFC_LITE_LOD_PX' },
    { line: 1, name: '__IFC_LITE_LOD_PX' },
    { line: 2, name: '__IFC_LITE_CHUNKS' },
    { line: 5, name: '__IFC_LITE_GPU_BUDGET_MB' },
  ]);
  assert.equal(findPerfGlobalReads('const el = <div data-x={window.__IFC_LITE_LOD_PX} />;', 'a.tsx').length, 1);
});

test('tests, the benchmark harness and the allowed readers are exempt from the ratchet', () => {
  const { isScanned, ALLOWED_READERS } = need(gate, 'check-perf-flags');
  assert.equal(isScanned('apps/viewer/src/utils/lodConfig.ts'), true);
  assert.equal(isScanned('packages/geometry/src/geometry-parallel.ts'), true);
  assert.equal(isScanned('apps/viewer/src/utils/lodConfig.test.ts'), false);
  assert.equal(isScanned('apps/viewer/src/test/harness.ts'), false);
  assert.equal(isScanned('tests/benchmark/example-harness.ts'), false);
  for (const path of ALLOWED_READERS) assert.equal(isScanned(path), false, path);
});

test('the real repository passes the gate', () => {
  const script = fileURLToPath(new URL('./check-perf-flags.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /check-perf-flags: OK/);
});
