/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { cliSample } from './retained-qual-cli.mjs';
import { nativeSample } from './retained-qual-native-memory.mjs';

function fixture(t, timeoutMs = 500) {
  const dir = mkdtempSync(join(tmpdir(), 'qual-deadline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'packages/cli/dist'), { recursive: true });
  const cli = join(dir, 'packages/cli/dist/index.js');
  const runCli = () => cliSample({ arm: { checkout: dir, side: 'branch', engine: dir, identity: { engine: {} } },
    fixture: { path: join(dir, 'model.ifc') }, round: 1, options: { 'timeout-ms': timeoutMs } });
  const runNative = () => nativeSample({ command: [process.execPath, cli, '--out', dir],
    summaryPath: join(dir, 'summary.json'), workerName: 'node', timeoutMs: 500 });
  return { dir, cli, runCli, runNative };
}

for (const kind of ['CLI export', 'CLI control', 'native']) {
  test(`7955: ${kind} timeout kills descendants and allows the next sample`, async t => {
    const f = fixture(t), marker = join(f.dir, 'descendant-survived');
    // Finite sleeps make the pre-fix regression safe to run. The descendant ignores
    // SIGTERM and inherits pipes: killing just /usr/bin/time cannot pass this test.
    writeFileSync(f.cli, `
      const { spawn } = require('node:child_process');
      ${kind === 'CLI export' ? "if (process.argv.includes('--version')) process.exit(0);" : ''}
      spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1200);`)}], { stdio: 'inherit' });
      setTimeout(() => process.exit(0), 1500);
    `);
    const run = kind === 'native' ? f.runNative : f.runCli;
    const row = await run();
    // Wait for the descendant's side effect before assertions, even on old code.
    await delay(1400);
    assert.equal(row.ok, false);
    assert.equal(row.error, 'timeout');
    assert.equal(existsSync(marker), false, 'descendant must be killed too');
    writeFileSync(f.cli, "if (process.argv.includes('--version')) process.exit(0); process.stderr.write('next sample reached'); process.exit(7);");
    const next = await run();
    assert.equal(next.ok, false);
    assert.notEqual(next.error, 'timeout');
    assert.match(next.error, /7/);
  });
}

for (const stage of ['export', 'control']) {
  test(`7955: CLI ${stage} failure retains the final 8 KiB of stderr`, async t => {
    const f = fixture(t);
    const stderr = 'discard this prefix\n' + 'x'.repeat(12000) + '\nFINAL Holter error\n';
    writeFileSync(f.cli, `${stage === 'export' ? "if (process.argv.includes('--version')) process.exit(0);" : ''}
      process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(7));`);
    const row = await f.runCli();
    assert.equal(row.ok, false);
    assert.equal(row.stderrTail, stderr.slice(-8192));
    assert.match(row.error, /FINAL Holter error/);
  });
}

for (const stage of ['export', 'control']) {
  test(`8868: CLI ${stage} distinguishes SIGSEGV from exit 139 after scratch cleanup`, {
    skip: process.platform === 'win32' && 'POSIX signal status contract',
  }, async t => {
    const f = fixture(t, 10000);
    const prefix = stage === 'export' ? "if (process.argv.includes('--version')) process.exit(0);" : '';
    for (const crashes of [false, true]) {
      writeFileSync(f.cli, prefix + (crashes ? "process.kill(process.pid, 'SIGSEGV');" : 'process.exit(139);'));
      const row = await f.runCli();
      assert.equal(row.ok, false);
      assert.equal(row.stderrTail, '');
      const status = row.processes.at(-1);
      assert.equal(status.stage, stage);
      assert.ok(status.pid > 0);
      assert.equal(status.terminationSignal, crashes ? 'SIGSEGV' : null);
      if (status.timeWrapped) {
        assert.equal(status.exitCode, 139);
        assert.equal(status.signal, null);
        assert.equal(status.timeDiagnostic, crashes ? 'Command terminated by signal 11' : 'Command exited with non-zero status 139');
      } else {
        assert.equal(status.signal, crashes ? 'SIGSEGV' : null);
        assert.equal(status.exitCode, crashes ? null : 139);
      }
    }
  });
}
