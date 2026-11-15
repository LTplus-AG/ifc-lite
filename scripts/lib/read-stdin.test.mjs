// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const READER = new URL('./read-stdin.mjs', import.meta.url);

test('readStdinUtf8 preserves UTF-8 across the nodejs/node#66341 short-read trigger', async () => {
  const burstStart = 72_000;
  const input = Buffer.alloc(166_386, 0x61);
  input.write('🧱', 3_998);
  input.write('🧱', burstStart + 16 * 1024 - 2);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readStdinUtf8 } from ${JSON.stringify(READER.href)};
    process.stdout.write(readStdinUtf8());
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [];
  const errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  for (let offset = 0; offset < 72_000; offset += 4_000) {
    const slice = input.subarray(offset, offset + 4_000);
    if (!child.stdin.write(slice)) await new Promise((resolve) => child.stdin.once('drain', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.stdin.end(input.subarray(72_000));

  const result = await exit;
  assert.deepEqual(result, { code: 0, signal: null }, Buffer.concat(errors).toString());
  const outputBytes = Buffer.concat(output);
  assert.deepEqual(outputBytes, input);
  assert.equal(outputBytes.toString('utf8'), input.toString('utf8'));
});
