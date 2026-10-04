/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute, executeStartupControl } from './native-hosted-process.mjs';

// #6537 Observe real timer registration while forwarding to the real timer;
// the finite child, process census, raw pipes and cleanup are not mocked.
test('#6537 actual normal execution stays 250ms while the named startup control uses only 2ms', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-observation-policy-'));
  const registered = [], realInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (...args) => {
    registered.push(args[1]); return realInterval(...args);
  });
  const command = [process.execPath, '-e', 'setTimeout(() => { console.log("finite control"); }, 300)'];
  try {
    for (const [run, scope, intervalMs] of [[execute, 'normal-native-execution', 250],
      [executeStartupControl, 'startup-control-only', 2]]) {
      const start = registered.length;
      const row = await run(command, directory, join(directory, scope), { wallMs: 5000 });
      assert.equal(row.status, 'complete', row.reason);
      assert.deepEqual(registered.slice(start), [intervalMs], 'the actual registered monitor uses the fixed entrypoint policy');
      assert.deepEqual(row.observationPolicy, { scope, intervalMs });
      assert.ok(row.samples.length > 0, 'actual process ancestry observations are retained');
      assert.equal(readFileSync(row.paths.stdout, 'utf8'), 'finite control\n');
      assert.equal(readFileSync(row.paths.stderr, 'utf8'), '');
      assert.equal(row.cleanup.status, 'complete');
      assert.ok(row.flush.every(item => item.status === 'complete'), 'both real log pipes finish');
      assert.equal(row.exit, 0);
    }
  } finally {
    t.mock.restoreAll(); rmSync(directory, { recursive: true, force: true });
  }
});
test('#6537 polling overrides cannot alter either entrypoint or launch a child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-observation-override-'));
  try {
    for (const run of [execute, executeStartupControl]) {
      for (const option of [{ pollMs: 1 }, { observationMs: 1 }, { intervalMs: 1 },
        { observationPolicy: { intervalMs: 1 } }, { sample: false, tools: undefined, wallMs: 5000, extra: 2 }]) {
        await assert.rejects(run([process.execPath, '-e', 'process.exit(97)'], directory,
          join(directory, 'must-not-open'), option), /observation policy override refused/);
        assert.deepEqual(readdirSync(directory), [], 'refusal occurs before creating child log files');
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
