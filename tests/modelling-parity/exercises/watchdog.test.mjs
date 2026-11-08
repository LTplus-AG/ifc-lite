/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
test('#9296 F5 watchdog publishes a failed summary and exits within the bound',()=>{
  const out=mkdtempSync(resolve(tmpdir(),'parity-watchdog-'));
  try {
    const r=spawnSync(process.execPath,['tests/modelling-parity/exercises/f5.mjs','--floors','40','--budget-s','0.001'],{env:{...process.env,PARITY_OUT:out},timeout:10000,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const results=JSON.parse(readFileSync(resolve(out,'F5-40/results.json'),'utf8'));
    const summary=results.at(-1);
    assert.equal(summary.status,'fail');
    assert.ok(results.some(r=>r.id.endsWith('.execution')&&/budget/i.test(r.reason)));
    assert.ok(summary.metrics.ms<10000);
    assert.ok(results.every(r=>r.schema==='ifclite-parity-result/1'&&r.probe==='exercise'));
  } finally { rmSync(out,{recursive:true,force:true}); }
});
