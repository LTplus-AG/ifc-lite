/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
const { launchOwnedJob, OwnedJobProtocolError } = await tsImport('./frame-gpu-job-controller.ts', import.meta.url);
const literal = value => `'${value.replaceAll("'", "''")}'`;
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual Windows Job protocol unavailable; containment unqualified' : false;

function ownedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-job-controller-cpu-'));
  const conversion = spawnSync('wslpath', ['-w', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(conversion.status, 0, conversion.stderr);
  const win = conversion.stdout.trim();
  for (const filename of ['frame-gpu-job.cs', 'frame-gpu-job-input.cs', 'frame-gpu-job-supervisor.ps1']) {
    writeFileSync(join(dir, filename), readFileSync(new URL(filename, import.meta.url)));
  }
  writeFileSync(join(dir, 'child.ps1'), `[IO.File]::WriteAllText(${literal(win + '\\child.pid')},$PID.ToString());Start-Sleep -Seconds 60`);
  writeFileSync(join(dir, 'root.ps1'), `[IO.File]::WriteAllText(${literal(win + '\\root.started')},$PID.ToString());Start-Process -FilePath ${literal(probe.stdout.trim())} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${win}\\child.ps1"');Start-Sleep -Seconds 2`);
  const options = { token: randomBytes(16).toString('hex'), executable: probe.stdout.trim(),
    commandLine: `"${probe.stdout.trim()}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${win}\\root.ps1"`,
    supervisorWin: win + '\\frame-gpu-job-supervisor.ps1', jobModuleWin: win + '\\frame-gpu-job.cs',
    inputModuleWin: win + '\\frame-gpu-job-input.cs', requestMs: 15000, cleanupMs: 10000, lifetimeSeconds: 60 };
  return { dir, options };
}
async function until(predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Actual owned CPU fixture did not reach its asserted state');
}

test('#7036 actual Job protocol persists before resume and retires an orphan CPU child', { skip, timeout: 60000 }, async () => {
  const { dir, options } = ownedFixture();
  let owner;
  const controller = await launchOwnedJob({ ...options, async persistPrepared(prepared) {
    assert.equal(existsSync(join(dir, 'root.started')), false, 'root is suspended before durable bookkeeping');
    owner = prepared;
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(prepared), { flag: 'wx' });
  } });
  let disposed = false;
  try {
    await until(() => existsSync(join(dir, 'child.pid')));
    const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
    let snapshot = [];
    await until(async () => { snapshot = await controller.snapshot(); return !snapshot.some(row => row.pid === owner.rootPid); });
    assert.ok(snapshot.some(row => row.pid === childPid), 'authoritative Job retains child after actual root exit');
    await controller.dispose(); disposed = true;
    assert.ok(controller.receipts.some(row => row.event === 'disposed' && row.activeProcesses === 0));
    assert.ok(controller.receipts.some(row => row.event === 'terminal' && row.ok === true));
  } finally {
    if (!disposed) await controller.dispose();
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ owner, packets: controller.receipts }, null, 2));
  }
});

test('#7036 failed durable Job persistence never resumes the actual suspended CPU root', { skip, timeout: 45000 }, async () => {
  const { dir, options } = ownedFixture();
  let owner;
  await assert.rejects(launchOwnedJob({ ...options, async persistPrepared(prepared) {
    owner = prepared;
    assert.equal(existsSync(join(dir, 'root.started')), false);
    throw Error('Controlled durable owner write refusal');
  } }), /Controlled durable owner write refusal/);
  assert.ok(owner, 'actual prepared root identity was observed');
  assert.equal(existsSync(join(dir, 'root.started')), false, 'refused persistence cannot execute fixture code');
  const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.rootPid}' | Where-Object {$_.CreationDate.ToUniversalTime().Ticks.ToString() -eq '${owner.rootCreated}'}).Count`],
  { encoding: 'utf8', timeout: 10000 });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ owner, status: check.status, stdout: check.stdout, stderr: check.stderr }, null, 2));
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim(), '0', 'failed persistence retires the exact observed suspended root');
});

test('#7036 actual terminal active-zero acknowledgement cannot hide failed supervisor exit', { skip, timeout: 60000 }, async () => {
  const { dir, options } = ownedFixture();
  // Execute the actual supervisor and kernel Job lifecycle, then inject a real
  // failing process exit AFTER its terminal acknowledgement. No canned packets.
  const supervisor = join(dir, 'frame-gpu-job-supervisor.ps1');
  writeFileSync(supervisor, readFileSync(supervisor, 'utf8') + '\nexit 7\n');
  const controller = await launchOwnedJob({ ...options, async persistPrepared(owner) {
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
  } });
  let disposeAttempted = false;
  try {
    await until(() => existsSync(join(dir, 'root.started')));
    disposeAttempted = true;
    await assert.rejects(controller.dispose(), error => {
      writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ packets: controller.receipts,
        retirement: error.retirement, error: String(error) }, null, 2));
      assert.ok(error instanceof OwnedJobProtocolError);
      assert.ok(error.receipts.some(packet => packet.event === 'disposed' && packet.activeProcesses === 0));
      assert.ok(error.receipts.some(packet => packet.event === 'terminal' && packet.ok === true));
      assert.deepEqual(error.retirement, { code: 7, signal: null });
      assert.match(String(error), /retirement status failed/);
      return true;
    });
  } finally {
    if (!disposeAttempted) {
      try { await controller.dispose(); }
      catch (error) { console.error(`Controlled failed-exit fixture cleanup receipt: ${String(error)}`); }
    }
    // The production dispose operation always reaches bounded EOF cleanup on
    // failure; its receipt preserves the nonzero status instead of success.
    writeFileSync(join(dir, 'packets.json'), JSON.stringify(controller.receipts, null, 2));
  }
});
