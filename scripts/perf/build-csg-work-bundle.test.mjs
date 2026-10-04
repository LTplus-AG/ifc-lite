// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePorcelain, run } from './build-csg-work-bundle.mjs';

test('#6516 builder keeps porcelain status columns and captures child stdout separately from its log path', async () => {
  assert.deepEqual(parsePorcelain(' M tracked.rs\n?? new.rs\n'), [' M tracked.rs', '?? new.rs']);
  const root = await mkdtemp(join(tmpdir(), 'csg-bundle-builder-test-'));
  try {
    const expected = 'capture-check\n';
    const result = await run('stdout-probe', process.execPath, ['-e', `process.stdout.write(${JSON.stringify(expected)})`], {
      logDir: join(root, 'logs'), bundleRoot: root,
    });
    assert.equal(result.rawStdout, expected);
    assert.equal(result.stdout, 'logs/stdout-probe.stdout.log');
    assert.equal(await readFile(join(root, result.stdout), 'utf8'), expected);
    assert.equal(result.stdoutSha256, createHash('sha256').update(expected).digest('hex'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
