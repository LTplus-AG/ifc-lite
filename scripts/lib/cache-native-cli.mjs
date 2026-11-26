/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The streaming CLI's part of `scripts/cache-native-conformance.mjs` (#9584):
 * `ifc-build-cache` (`build_cache_to_path`) must write the same bytes and
 * stats as the in-memory `build_cache`, over an output that already holds a
 * stale file, and leave no staging file behind. Everything the conformance
 * script asserts about the in-memory cache then holds for the CLI's too.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Runs `cliBin` on `sourcePath` in `work` and compares it with `native`. */
export function assertStreamedMatches({ cliBin, work, sourcePath, native, label }) {
  const out = join(work, 'streamed.ifclite');
  writeFileSync(out, 'stale');
  const run = spawnSync(cliBin, [sourcePath, out], { encoding: 'utf8' });
  assert.equal(run.status, 0, `ifc-build-cache failed: ${run.stderr}`);
  const bytes = readFileSync(out);
  const stats = JSON.parse(run.stdout);
  assert.ok(bytes.equals(native.bytes), `${label}: ifc-build-cache (streamed) differs from build_cache`);
  for (const [key, value] of Object.entries(native.stats)) {
    assert.equal(stats[key], value, `${label}: ifc-build-cache stats.${key}`);
  }
  assert.deepEqual(readdirSync(work).filter((name) => name.startsWith('.')), [], `${label}: no staging file left`);
}
