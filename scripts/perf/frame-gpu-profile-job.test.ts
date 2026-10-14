/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChromeOwner, launchOwnedProfileJob, windowsCommandLine } from './frame-gpu-chrome-owner.js';
import { OwnedJobProtocolError } from './frame-gpu-job-controller.js';
import { readPowerShellJson } from './frame-gpu-session.js';
import { createWindowsCpuFixture } from './frame-gpu-cpu-fixture.mjs';

// #6975: actual CPU processes use the same owner/Job binding as Chrome. These
// controls never start Chrome/GPU or certify broker-created descendants.
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual Windows profile Job controls unavailable; integration held' : false;
const limits = { requestMs: 15000, cleanupMs: 10000, lifetimeSeconds: 60 };
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Actual owned CPU fixture did not reach its asserted state');
}
function fixture() {
  const ledger = mkdtempSync(join(tmpdir(), 'ifc-profile-job-ledger-'));
  const owner = createChromeOwner(ledger);
  const converted = spawnSync('wslpath', ['-w', ledger], { encoding: 'utf8', timeout: 5000 });
  assert.equal(converted.status, 0, converted.stderr);
  const ledgerWin = converted.stdout.trim();
  const cpu = createWindowsCpuFixture('profile-orphan');
  return { owner, ledger, cpu, executable: cpu.executable,
    args: ['--fixture-mode=profile-orphan', `--fixture-root=${cpu.win}`,
      `--fixture-ledger=${ledgerWin}`, `--fixture-owner-token=${owner.token}`, `--user-data-dir=${owner.profileWin}`] };
}
function exactRootAbsent(job: { rootPid: number; rootCreated: string }): boolean {
  const nativePath = spawnSync('wslpath', ['-w', fileURLToPath(new URL('./frame-gpu-process-identity.cs', import.meta.url))], { encoding: 'utf8', timeout: 5000 });
  assert.equal(nativePath.status, 0, nativePath.stderr);
  const value = readPowerShellJson(`$ErrorActionPreference='Stop'; Add-Type -Path ${literal(nativePath.stdout.trim())}; [IfcProcessIdentity]::ObserveExact(${job.rootPid},${literal(job.rootCreated)})|ConvertTo-Json -Compress`);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const state: unknown = Reflect.get(value, 'state');
  assert.ok(state === 'live' || state === 'exited' || state === 'notFound');
  assert.equal(Reflect.get(value, 'pid'), job.rootPid);
  if (state !== 'notFound') assert.equal(Reflect.get(value, 'started'), job.rootCreated);
  return state === 'exited' || state === 'notFound';
}

test('#6975 actual owner binding persists before CPU root and retires orphan before deleting exclusive profile', { skip, timeout: 60000 }, async context => {
  const { owner, ledger, args, executable, cpu } = fixture();
  const foreign = createChromeOwner();
  writeFileSync(join(foreign.profileWsl, 'foreign-sentinel'), 'untouched');
  const session = await launchOwnedProfileJob(owner, executable, args, limits);
  try {
    await until(() => existsSync(join(cpu.dir, 'child.json')));
    const child: unknown = JSON.parse(readFileSync(join(cpu.dir, 'child.json'), 'utf8'));
    assert.ok(child && typeof child === 'object');
    const childPid: unknown = Reflect.get(child, 'pid'), childCreated: unknown = Reflect.get(child, 'created');
    assert.ok(typeof childPid === 'number' && Number.isSafeInteger(childPid) && childPid > 0);
    assert.ok(typeof childCreated === 'string' && /^[1-9][0-9]*$/.test(childCreated));
    await until(async () => {
      const live = await session.controller.snapshot();
      return !live.some(row => row.pid === session.prepared.job.rootPid) && live.some(row => row.pid === childPid && row.started === childCreated);
    });
    assert.equal(readFileSync(join(ledger, `${owner.token}.job.json`), 'utf8'), readFileSync(join(owner.profileWsl, '.ifclite-frame-job.json'), 'utf8'));
    assert.equal(await session.dispose(), null);
    assert.equal(await session.dispose(), null, 'cached disposition remains proven');
    assert.ok(exactRootAbsent({ rootPid: childPid, rootCreated: childCreated }), 'Exact orphan birth identity retired');
    assert.equal(existsSync(owner.profileWsl), false);
    assert.equal(existsSync(join(ledger, `${owner.token}.disposed.json`)), true);
    assert.equal(readFileSync(join(foreign.profileWsl, 'foreign-sentinel'), 'utf8'), 'untouched');
    context.diagnostic(JSON.stringify({ prepared: session.prepared, packets: session.controller.receipts }));
  } finally {
    const error = await session.dispose();
    if (error) console.error(error);
    rmSync(foreign.profileWsl, { recursive: true }); // This foreign fixture never spawned a root.
  }
});

test('#6975 actual partial prepared ledger refuses resume and retains profile after suspended-root retirement', { skip, timeout: 45000 }, async context => {
  const { owner, ledger, args, executable, cpu } = fixture();
  writeFileSync(join(ledger, `${owner.token}.job.json`), 'preserve preexisting record', { flag: 'wx' });
  await assert.rejects(launchOwnedProfileJob(owner, executable, args, limits), error => {
    assert.ok(error instanceof OwnedJobProtocolError);
    context.diagnostic(JSON.stringify({ packets: error.receipts, retirement: error.retirement, error: String(error) }));
    return true;
  });
  assert.equal(existsSync(join(cpu.dir, 'root.started')), false);
  const prepared: unknown = JSON.parse(readFileSync(join(owner.profileWsl, '.ifclite-frame-job.json'), 'utf8'));
  assert.ok(prepared && typeof prepared === 'object');
  const job: unknown = Reflect.get(prepared, 'job');
  assert.ok(job && typeof job === 'object');
  const rootPid: unknown = Reflect.get(job, 'rootPid'), rootCreated: unknown = Reflect.get(job, 'rootCreated');
  assert.ok(typeof rootPid === 'number' && typeof rootCreated === 'string');
  assert.ok(exactRootAbsent({ rootPid, rootCreated }));
  assert.equal(readFileSync(join(ledger, `${owner.token}.job.json`), 'utf8'), 'preserve preexisting record');
  assert.equal(existsSync(owner.profileWsl), true);
  assert.equal(existsSync(join(ledger, `${owner.token}.disposed.json`)), false);
});

test('#6975 altered marker retires only the live known Job and retains unverified profile', { skip, timeout: 60000 }, async context => {
  const { owner, ledger, args, executable, cpu } = fixture();
  const session = await launchOwnedProfileJob(owner, executable, args, limits);
  try {
    await until(() => existsSync(join(cpu.dir, 'root.started')));
    writeFileSync(join(owner.profileWsl, '.ifclite-frame-owner.json'), 'altered marker');
    assert.match(await session.dispose() ?? '', /retirement refused/);
    assert.ok(exactRootAbsent(session.prepared.job));
    assert.equal(existsSync(owner.profileWsl), true);
    assert.equal(existsSync(join(ledger, `${owner.token}.disposed.json`)), false);
    assert.ok(session.controller.receipts.some(row => row.event === 'disposed' && row.activeProcesses === 0));
    context.diagnostic(JSON.stringify({ packets: session.controller.receipts, refusal: await session.dispose() }));
  } finally {
    const error = await session.dispose();
    if (error) console.error(error);
  }
});

test('#6975 composed Windows command line round-trips real Win32 parser with quoted profile arguments', { skip }, () => {
  const executable = probe.stdout.trim();
  const args = ['--user-data-dir=C:\\Temp\\O\'Brien owned profile', 'embedded"quote', 'trailing\\', '', 'whole argument'];
  const command = windowsCommandLine(executable, args);
  const shared = readFileSync(new URL('./frame-gpu-owned-profile.ps1', import.meta.url), 'utf8');
  const raw = readPowerShellJson(`$ErrorActionPreference='Stop'; ${shared}\nConvertTo-Json -InputObject @([IfcChromeArgs]::Split(${literal(command)})) -Compress`);
  assert.deepEqual(raw, [executable, ...args]);
});

test('#6975 owner mutation during actual asynchronous Job retirement refuses profile deletion', { skip, timeout: 60000 }, async context => {
  const { owner, ledger, args, executable, cpu } = fixture();
  const session = await launchOwnedProfileJob(owner, executable, args, limits);
  try {
    await until(() => existsSync(join(cpu.dir, 'root.started')));
    // The production disposal has synchronously read its marker and is awaiting
    // the real Windows Job operation. Mutate the disk binding before it resumes.
    const disposing = session.dispose();
    writeFileSync(join(owner.profileWsl, '.ifclite-frame-owner.json'), 'changed during retirement');
    assert.match(await disposing ?? '', /retirement refused/);
    assert.ok(exactRootAbsent(session.prepared.job));
    assert.equal(existsSync(owner.profileWsl), true);
    assert.equal(existsSync(join(ledger, `${owner.token}.disposed.json`)), false);
    assert.ok(session.controller.receipts.some(row => row.event === 'disposed' && row.activeProcesses === 0));
    context.diagnostic(JSON.stringify({ packets: session.controller.receipts, refusal: await session.dispose() }));
  } finally {
    const error = await session.dispose();
    if (error) console.error(error);
  }
});

test('#6975 actual whole-sample abort retires the owned CPU Job and permits deletion only after proof', { skip, timeout: 60000 }, async context => {
  const { owner, ledger, args, executable, cpu } = fixture();
  const cancellation = new AbortController();
  const session = await launchOwnedProfileJob(owner, executable, args, { ...limits, signal: cancellation.signal });
  try {
    await until(() => existsSync(join(cpu.dir, 'root.started')));
    cancellation.abort(new Error('controlled CPU sample cancellation'));
    assert.equal(await session.dispose(), null);
    assert.equal(existsSync(owner.profileWsl), false);
    assert.equal(existsSync(join(ledger, `${owner.token}.disposed.json`)), true);
    assert.ok(exactRootAbsent(session.prepared.job));
    context.diagnostic(JSON.stringify({ prepared: session.prepared, packets: session.controller.receipts }));
  } finally {
    const error = await session.dispose();
    if (error) console.error(error);
  }
});
