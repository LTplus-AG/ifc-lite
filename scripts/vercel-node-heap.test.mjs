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

// A fake /proc/meminfo so the budget rule can be exercised on any host; the
// real file is only consulted when this override is absent.
const eightGb = 'MemTotal:        8104856 kB\nMemFree:          123456 kB\n';
const fourGb = 'MemTotal:        4028240 kB\nMemFree:          123456 kB\n';

function configuredNodeOptions(overrides = {}, { meminfo = eightGb } = {}) {
  const meminfoPath = join(tmpdir(), `ifc-lite-meminfo-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(meminfoPath, meminfo);
  try {
    const env = { ...process.env, VERCEL_NODE_HEAP_MEMINFO: meminfoPath, ...overrides };
    for (const key of ['NODE_OPTIONS', 'VERCEL_NODE_MAX_OLD_SPACE_MB']) {
      if (overrides[key] === undefined) delete env[key];
    }
    const result = spawnSync('bash', ['-c', '. scripts/lib/vercel-node-heap.sh; configure_vercel_node_heap >/dev/null; printf %s "$NODE_OPTIONS"'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(meminfoPath, { force: true });
  }
}

test('Vercel Node heap defaults to 5 GiB and accepts an explicit project override (#4990)', () => {
  assert.equal(configuredNodeOptions(), '--max-old-space-size=5120');
  assert.equal(configuredNodeOptions({ VERCEL_NODE_MAX_OLD_SPACE_MB: '7000' }), '--max-old-space-size=7000');
});

test('Vercel Node heap preserves other flags and keeps an existing cap that fits the budget (#4990)', () => {
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--no-warnings' }), '--no-warnings --max-old-space-size=5120');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size=3000' }), '--max-old-space-size=3000');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=3500' }), '--max_old_space_size=3500');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size 4000' }), '--max-old-space-size 4000');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size 4500' }), '--max_old_space_size 4500');
});

test("Vercel Node heap replaces the build image's 8 GB cap on the 8 GB builder (#5132)", () => {
  // Vercel's image exports exactly this; kept as-is it let V8 grow until the
  // kernel OOM-killed vite at "rendering chunks" (exit 137) on production
  // builds 51c36ecd9 / 707cc22a0 / 6c01865b8 / 13a04c038.
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=8192' }), '--max-old-space-size=5120');
  assert.equal(
    configuredNodeOptions({ NODE_OPTIONS: '--no-warnings --max_old_space_size=8192 --title=viewer' }),
    '--no-warnings --title=viewer --max-old-space-size=5120',
  );
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size 8192' }), '--max-old-space-size=5120');
  // The documented project override still wins outright, in both directions.
  assert.equal(
    configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=8192', VERCEL_NODE_MAX_OLD_SPACE_MB: '7000' }),
    '--max-old-space-size=7000',
  );
  assert.equal(
    configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=6000', VERCEL_NODE_MAX_OLD_SPACE_MB: '7000' }),
    '--max_old_space_size=6000',
  );
});

test('Vercel Node heap budget follows a smaller machine (#5132)', () => {
  // 4 GB: 3933 MB * 62 % = 2438, below the 5120 default.
  assert.equal(configuredNodeOptions({}, { meminfo: fourGb }), '--max-old-space-size=2438');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=8192' }, { meminfo: fourGb }), '--max-old-space-size=2438');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size=2000' }, { meminfo: fourGb }), '--max-old-space-size=2000');
  // An unreadable meminfo falls back to the 5 GB default rather than failing.
  assert.equal(configuredNodeOptions({ VERCEL_NODE_HEAP_MEMINFO: '/nonexistent/meminfo' }), '--max-old-space-size=5120');
});

test('Vercel Node heap ignores heap-like text inside another option value (#4990)', () => {
  assert.equal(
    configuredNodeOptions({ NODE_OPTIONS: '--title=--max-old-space-size' }),
    '--title=--max-old-space-size --max-old-space-size=5120',
  );
});

test('Turbo forwards the configured heap cap to every strict-env build task (#4990)', () => {
  const turbo = JSON.parse(readFileSync(new URL('turbo.json', root), 'utf8'));
  assert.ok(
    turbo.globalPassThroughEnv?.includes('NODE_OPTIONS'),
    'without this pass-through, Vercel sets the cap but Turbo strips it before Vite runs',
  );
});
