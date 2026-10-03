/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGpuChild } from './gpu-outer.mjs';
function setup(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'ifc-gpu-outer-'));
  const child = join(directory, 'child.mjs');
  writeFileSync(child, `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(join(directory, 'control.json'))},JSON.stringify({status:'observed',events:[]}));
    writeFileSync(${JSON.stringify(join(directory, 'events.jsonl'))},'');
    console.log('actual-child-output');
    ${mode === 'backend' ? "console.error('ERROR: unable to initialize Dawn');" : ''}
    ${mode === 'timeout' ? 'setInterval(()=>{},1000);' : ''}
    ${mode === 'prefix' ? "process.stdout.write(Buffer.alloc(17*1024*1024,120));" : ''}`);
  return { directory, capture: () => runGpuChild({ root: directory, output: directory, name: 'control',
    args: [child], eventFile: 'events.jsonl', wallMs: mode === 'timeout' ? 500 : 5000 }) };
}
test('#6537 shared GPU wrapper drains real child logs and witnesses detached ownership', async () => {
  const f = setup('normal');
  try {
    const r = await f.capture();
    assert.equal(r.exit.code, 0); assert.equal(r.refusal, undefined);
    assert.equal(r.row.rootIdentity.pid, r.row.rootIdentity.pgrp);
    assert.equal(r.cleanup.status, 'complete'); assert.equal(r.cleanup.remaining.length, 0);
    assert.ok(r.flushes.every(x => x.status === 'complete'));
    assert.equal(readFileSync(r.paths[0], 'utf8'), 'actual-child-output\n');
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
test('#6537 shared GPU wrapper preserves actual backend stderr and timeout refusal', async () => {
  for (const mode of ['backend', 'timeout']) {
    const f = setup(mode);
    try {
      const r = await f.capture();
      if (mode === 'backend') { assert.equal(r.backend.length, 1); assert.equal(readFileSync(r.paths[1], 'utf8'), 'ERROR: unable to initialize Dawn\n'); }
      else { assert.match(r.refusal, /wall deadline/); assert.equal(r.exit.signal, 'SIGKILL'); }
      assert.equal(r.cleanup.status, 'complete');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  }
});
test('#6537 shared GPU wrapper refuses an actual oversized raw stream instead of certifying its prefix', async () => {
  const f = setup('prefix');
  try {
    const r = await f.capture();
    assert.match(r.refusal, /retained prefix only, tail uncertified/);
    assert.equal(r.row.logBytes[0], 16 * 1024 ** 2);
    assert.equal(readFileSync(r.paths[0]).length, r.row.logBytes[0]);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
