/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);

// Fake /proc/meminfo files: Linux reports an 8 GB box as ~7.9 GB and a 16 GB
// one as ~15.6 GB.
const basicBuilder = 'MemTotal:        8104856 kB\nMemFree:          123456 kB\n';
const enhancedBuilder = 'MemTotal:       16334284 kB\nMemFree:          123456 kB\n';
const keys = { POSTHOG_CLI_API_KEY: 'phx_test', POSTHOG_CLI_ENV_ID: '199147' };

// Returns { on, vite, log } for one configuration: the function's exit status,
// the VITE_SOURCEMAP it exported, and what it printed.
function decide(overrides = {}, { meminfo = basicBuilder } = {}) {
  const meminfoPath = join(tmpdir(), `ifc-lite-sourcemaps-meminfo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(meminfoPath, meminfo);
  try {
    const env = { ...process.env, VERCEL_SOURCEMAPS_MEMINFO: meminfoPath, ...overrides };
    for (const key of ['VITE_SOURCEMAP', 'VERCEL_SOURCEMAPS', 'POSTHOG_CLI_API_KEY', 'POSTHOG_CLI_ENV_ID']) {
      if (overrides[key] === undefined) delete env[key];
    }
    const result = spawnSync(
      'bash',
      ['-c', '. scripts/lib/vercel-sourcemaps.sh; if configure_vercel_sourcemaps >/dev/null; then on=1; else on=0; fi; printf "%s\\t%s" "$on" "${VITE_SOURCEMAP:-}"'],
      { cwd: root, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const [on, vite] = result.stdout.split('\t');
    return { on: on === '1', vite };
  } finally {
    rmSync(meminfoPath, { force: true });
  }
}

test('source maps stay off without the PostHog CLI keys, whatever the machine (#5132)', () => {
  assert.deepEqual(decide({}, { meminfo: enhancedBuilder }), { on: false, vite: '' });
  assert.deepEqual(decide({ POSTHOG_CLI_API_KEY: 'phx_test' }, { meminfo: enhancedBuilder }), { on: false, vite: '' });
});

test('source maps follow the machine when the keys are present (#5132)', () => {
  // The basic 8 GB builder: generating them OOM-killed the bundle (f927937e8).
  assert.deepEqual(decide(keys, { meminfo: basicBuilder }), { on: false, vite: '' });
  // The enhanced 16 GB builder gets symbolicated traces back automatically.
  assert.deepEqual(decide(keys, { meminfo: enhancedBuilder }), { on: true, vite: '1' });
  // An unreadable meminfo cannot prove the machine small, so the keys decide.
  assert.deepEqual(decide({ ...keys, VERCEL_SOURCEMAPS_MEMINFO: '/nonexistent/meminfo' }), { on: true, vite: '1' });
});

test('VERCEL_SOURCEMAPS forces the decision either way (#5132)', () => {
  assert.deepEqual(decide({ ...keys, VERCEL_SOURCEMAPS: '1' }, { meminfo: basicBuilder }), { on: true, vite: '1' });
  assert.deepEqual(decide({ VERCEL_SOURCEMAPS: '1' }, { meminfo: basicBuilder }), { on: true, vite: '1' });
  assert.deepEqual(decide({ ...keys, VERCEL_SOURCEMAPS: '0' }, { meminfo: enhancedBuilder }), { on: false, vite: '' });
});

test('an inherited VITE_SOURCEMAP=1 cannot re-enable maps behind an "off" decision (#5132)', () => {
  assert.deepEqual(decide({ ...keys, VERCEL_SOURCEMAPS: '0', VITE_SOURCEMAP: '1' }, { meminfo: enhancedBuilder }), { on: false, vite: '' });
  assert.deepEqual(decide({ ...keys, VITE_SOURCEMAP: '1' }, { meminfo: basicBuilder }), { on: false, vite: '' });
  assert.deepEqual(decide({ VITE_SOURCEMAP: '1' }, { meminfo: enhancedBuilder }), { on: false, vite: '' });
});

test('the build script uploads only when the same decision turned maps on (#5132)', () => {
  const script = readFileSync(new URL('scripts/vercel-build.sh', root), 'utf8');
  assert.match(script, /configure_vercel_sourcemaps/, 'the build script must source the shared decision');
  assert.match(
    script,
    /\[ "\$SOURCEMAPS_ON" = 1 \] && \[ -n "\$\{POSTHOG_CLI_API_KEY:-\}" \]/,
    'the upload must be gated on the decision, not on the keys alone, or a minified build would try to upload maps it never made',
  );
});
