/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);

function configuredNodeOptions(overrides = {}) {
  const env = { ...process.env, ...overrides };
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
}

test('Vercel Node heap defaults to 5 GiB and accepts an explicit project override (#4990)', () => {
  assert.equal(configuredNodeOptions(), '--max-old-space-size=5120');
  assert.equal(configuredNodeOptions({ VERCEL_NODE_MAX_OLD_SPACE_MB: '7000' }), '--max-old-space-size=7000');
});

test('Vercel Node heap preserves other flags and never overrides an existing cap (#4990)', () => {
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--no-warnings' }), '--no-warnings --max-old-space-size=5120');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size=3000' }), '--max-old-space-size=3000');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size=3500' }), '--max_old_space_size=3500');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max-old-space-size 4000' }), '--max-old-space-size 4000');
  assert.equal(configuredNodeOptions({ NODE_OPTIONS: '--max_old_space_size 4500' }), '--max_old_space_size 4500');
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
