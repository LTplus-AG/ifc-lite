// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const builderUrl = new URL('./build-csg-work-bundle.mjs', import.meta.url);
const consumer = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  const { parsePorcelain } = await import(${JSON.stringify(builderUrl.href)});
  assert.deepEqual(parsePorcelain(' M tracked.rs\\n?? new.rs\\n'), [' M tracked.rs', '?? new.rs']);
  assert.deepEqual(parsePorcelain(''), []);
`], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
function builderTest(name, body) {
  test(name, async () => {
    // #6516: whole-production removal must fail a real consumer invariant,
    // preserving the registered controls rather than becoming a loader error.
    assert.equal(consumer.status, 0, 'the real Node consumer could not preserve porcelain status columns');
    assert.equal(consumer.signal, null);
    return body();
  });
}
// No substitute implementation; a missing module reaches the assertion above.
const { parsePorcelain, run } = existsSync(builderUrl) ? await import(builderUrl.href) : {};

builderTest('#6516 builder keeps porcelain status columns and captures child stdout separately from its log path', async () => {
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
