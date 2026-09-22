/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// The gate runs as CI runs it (a separate process over the REAL tree), so this
// file loads even without the gate and fails by assertion, not by import.
test('the REAL docs tree has no page mkdocs --strict would reject as omitted from nav (#4912)', () => {
  // #4875 added docs/guide/cost-panel.md without a nav entry; the strict site
  // build in the ifclite.dev deploy then failed and froze the nightly
  // production advance. #5051's LandXML evidence ledger is another durable
  // architecture page, so it must remain reachable from the same real nav.
  const gate = join(HERE, 'check-mkdocs-nav.mjs');
  assert.ok(existsSync(gate), 'the docs nav gate (scripts/docs/check-mkdocs-nav.mjs) is missing');
  const run = spawnSync(process.execPath, [gate, '--root', REPO_ROOT], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.trim() || run.stdout.trim());
  assert.match(run.stdout, /every docs page is in mkdocs\.yml nav or declared not_in_nav/);
});
