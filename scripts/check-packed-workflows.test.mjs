/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// DX5: exercise the developer command, including its installed artifact and
// declaration checks. A missing script is a failed consumer entry point.
test('packed workflow command proves consumer behavior on real IFC bytes (DX5)', { timeout: 180000 }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pnpm = process.env.npm_execpath;
  const result = pnpm && /\.(c?js|mjs)$/i.test(pnpm)
    ? spawnSync(process.execPath, [pnpm, '--silent', 'test:packed'], { cwd: root, encoding: 'utf8', timeout: 170000 })
    : spawnSync('pnpm', ['--silent', 'test:packed'], { cwd: root, encoding: 'utf8', timeout: 170000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.packageVersions['@ifc-lite/sdk']);
  assert.ok(report.packageVersions['@ifc-lite/wasm']);
  const wall = report.receipts.find(receipt => receipt.type === 'IfcWall');
  assert.equal(wall?.count, 1);
  for (const receipt of report.receipts) {
    assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(new URL(`../${receipt.fixture}`, import.meta.url))).digest('hex'));
    assert.ok(receipt.meshes > 0);
  }
  if (existsSync(new URL('../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url))) {
    assert.equal(report.receipts.find(receipt => receipt.type === 'IfcDoor')?.count, 5);
  }
});
