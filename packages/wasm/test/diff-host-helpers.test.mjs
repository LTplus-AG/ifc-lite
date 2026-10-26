/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { currentMainOracle } from './diff-host-helpers.mjs';

const variable = 'IFC_LITE_CURRENT_MAIN_DIFF_ORACLE';

function spyContext() {
  const skips = [];
  return { skips, skip: reason => skips.push(reason), diagnostic() {} };
}

async function withOracleEnv(value, run) {
  const previous = process.env[variable];
  if (value === undefined) delete process.env[variable]; else process.env[variable] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
  }
}

test('an explicitly requested current-main oracle that is missing fails instead of skipping', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ifc-lite-missing-oracle-'));
  const missing = join(directory, 'dist', 'index.js');
  try {
    const context = spyContext();
    await withOracleEnv(missing, async () => {
      await assert.rejects(() => currentMainOracle(context), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(variable), error.message);
        assert.ok(error.message.includes(missing), error.message);
        return true;
      });
    });
    assert.deepEqual(context.skips, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unset oracle variable still skips when the local staging build is absent',
  { skip: existsSync(new URL('../../diff/dist/index.js', import.meta.url)) && 'local staging oracle is built' },
  async () => {
    const context = spyContext();
    const api = await withOracleEnv(undefined, () => currentMainOracle(context));
    assert.equal(api, undefined);
    assert.equal(context.skips.length, 1);
  });
