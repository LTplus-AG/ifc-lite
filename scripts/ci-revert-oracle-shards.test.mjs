/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PER_SHARD, SHARDS, WORKFLOW, checkCapacity, extractOracleScript, parseLedger, planTotal, shardList, shardOf, verify,
} from './ci-revert-oracle-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
const script = extractOracleScript(workflow);

/** Execute the REAL step script as shard k of S with stub node/cargo launchers. */
function runShard(shard, shards, { failAt = 0 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'revert-oracle-shard-'));
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  const calls = join(scratch, 'calls.txt');
  // Only the oracle launcher and cargo are substituted; git, the selection
  // chain and the sourced helpers are the repository's own.
  writeFileSync(join(bin, 'node'), `#!/bin/bash\necho "node $*" >> "${calls}"\n` +
    `n=$(grep -c '^node ' "${calls}")\n[ "$n" != "${failAt}" ]\n`);
  writeFileSync(join(bin, 'cargo'), `#!/bin/bash\necho "cargo $*" >> "${calls}"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'cargo'), 0o755);
  const ledger = join(scratch, 'ledger', 'ledger.txt');
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REVERT_ORACLE_SHARD: String(shard),
      REVERT_ORACLE_SHARDS: String(shards), REVERT_ORACLE_LEDGER: ledger },
  });
  const text = existsSync(ledger) ? readFileSync(ledger, 'utf8') : undefined;
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  rmSync(scratch, { recursive: true, force: true });
  return { status: result.status, ledger: text, log };
}

test('the real oracle step numbers at least the initial invocation, and plan mode runs none', () => {
  const total = planTotal(script);
  assert.ok(total >= 1, `the initial selected oracle always runs, got ${total}`);
  assert.equal(checkCapacity(total), total);
  assert.equal(shardList(workflow), SHARDS, 'the inline matrix and SHARDS agree');
});

test('the real step script, run as every planned shard, covers each oracle exactly once', () => {
  const total = planTotal(script);
  const shards = SHARDS;
  const ledgers = new Map();
  let oracleCalls = 0;
  for (let shard = 1; shard <= shards; shard++) {
    const run = runShard(shard, shards);
    assert.equal(run.status, 0, `shard ${shard} failed`);
    ledgers.set(shard, run.ledger);
    const calls = run.log.split('\n').filter((line) => line.startsWith('node scripts/check-test-revert-oracle.mjs '));
    assert.equal(calls.length, parseLedger(run.ledger).ran.length, 'every ledger entry is an executed oracle');
    oracleCalls += calls.length;
  }
  assert.equal(oracleCalls, total);
  assert.deepEqual(verify({ total, shards, ledgers }), []);
});

test('a shard whose oracle fails leaves no total, and the verdict refuses it', () => {
  const run = runShard(1, 1, { failAt: 1 });
  assert.notEqual(run.status, 0);
  assert.equal(parseLedger(run.ledger ?? '').total, null);
  const errors = verify({ total: 1, shards: 1, ledgers: new Map([[1, run.ledger ?? '']]) });
  assert.ok(errors.some((e) => /no total/.test(e)), errors.join('\n'));
});

test('verify refuses every way coverage could silently drop', () => {
  const total = 9;
  const shards = 3;
  const good = new Map();
  for (let shard = 1; shard <= shards; shard++) {
    const ran = [];
    for (let i = 1; i <= total; i++) if (shardOf(i, shards) === shard) ran.push(`ran ${i}`);
    good.set(shard, `${ran.join('\n')}\ntotal ${total}\n`);
  }
  assert.deepEqual(verify({ total, shards, ledgers: good }), []);

  const missing = new Map(good); missing.delete(2);
  assert.match(verify({ total, shards, ledgers: missing }).join('\n'), /shard 2: no ledger[\s\S]*oracle 2 was not run/);

  const skipped = new Map(good); skipped.set(1, `ran 1\ntotal ${total}\n`);
  assert.match(verify({ total, shards, ledgers: skipped }).join('\n'), /oracle 4 was not run/);

  const twice = new Map(good); twice.set(1, `${good.get(1)}`.replace('total', 'ran 1\ntotal'));
  assert.match(verify({ total, shards, ledgers: twice }).join('\n'), /oracle 1 ran 2 times/);

  const misplaced = new Map(good); misplaced.set(1, `${good.get(1)}`.replace('total', 'ran 2\ntotal'));
  assert.match(verify({ total, shards, ledgers: misplaced }).join('\n'), /ran oracle 2, assigned to shard 2/);

  const recount = new Map(good); recount.set(3, `${good.get(3)}`.replace(`total ${total}`, 'total 8'));
  assert.match(verify({ total, shards, ledgers: recount }).join('\n'), /numbered 8 oracles, the plan numbered 9/);

  assert.match(verify({ total: 13, shards, ledgers: good }).join('\n'), /13 oracles exceed 3 shards x 4/);
  assert.throws(() => parseLedger('ran x\n'), /malformed/);
  assert.throws(() => checkCapacity(0), /at least one oracle/);
  assert.throws(() => checkCapacity(SHARDS * PER_SHARD + 1), /extend the shard list/);
  assert.throws(() => shardList(workflow.replace(/shard: \[1, 2,/, 'shard: [1, 3,')), /must be 1\.\.n/);
});
