/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The viewer program needs ~4.8 GB of heap (2026-11-03), past Node's ~4.2 GB
// default, so every caller of its typecheck script ran out of memory on hosted
// runners. The script itself has to raise the limit.
test('the viewer typecheck runs tsc with at least an 8 GB heap', () => {
  const pkg = JSON.parse(readFileSync(new URL('../apps/viewer/package.json', import.meta.url), 'utf8'));
  const script = pkg.scripts.typecheck;
  const heap = /--max-old-space-size=(\d+)/.exec(script);
  assert.ok(heap, `viewer typecheck sets no heap size: ${script}`);
  assert.ok(Number(heap[1]) >= 8192, `viewer typecheck heap ${heap[1]} MiB is below 8192`);
  assert.match(script, /typescript\/bin\/tsc --noEmit/);
});
