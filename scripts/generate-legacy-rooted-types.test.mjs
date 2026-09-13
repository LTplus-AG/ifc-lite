/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the aggregate freshness command runs the legacy rooted-type generator (#4203)', () => {
  const script = fileURLToPath(new URL('./check-generated.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, IFC_LITE_GENERATED_GATE: 'legacy rooted-type freshness' },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  // Other independent freshness gates may be stale in a developer checkout;
  // this assertion is deliberately scoped to the new production gate and its
  // real generator output.
  assert.match(output, /Running legacy rooted-type freshness:/);
  assert.match(output, /✅ legacy rooted-type freshness: PASS/);
});
