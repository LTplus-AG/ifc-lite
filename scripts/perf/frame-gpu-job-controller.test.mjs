/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tsImport } from 'tsx/esm/api';
import { createWindowsCpuFixture, powershell, literal } from './frame-gpu-cpu-fixture.mjs';
const { launchOwnedJob, OwnedJobProtocolError } = await tsImport('./frame-gpu-job-controller.ts', import.meta.url);
const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'], { encoding: 'utf8', timeout: 10000 });
const skip = probe.error || probe.status !== 0 ? 'Actual Windows Job protocol unavailable; containment unqualified' : false;

function ownedFixture() {
  const fixture = createWindowsCpuFixture('controller-orphan');
  const { dir, win } = fixture;
  const options = { token: randomBytes(16).toString('hex'), executable: fixture.executable, commandLine: fixture.commandLine,
    supervisorWin: win + '\\frame-gpu-job-supervisor.ps1', jobModuleWin: win + '\\frame-gpu-job.cs',
    inputModuleWin: win + '\\frame-gpu-job-input.cs', requestMs: 15000, cleanupMs: 10000, lifetimeSeconds: 60 };
  return { ...fixture, options };
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
  const { dir, options, observeExact } = ownedFixture();
  let owner;
  const controller = await launchOwnedJob({ ...options, async persistPrepared(prepared) {
    assert.equal(existsSync(join(dir, 'root.started')), false, 'root is suspended before durable bookkeeping');
    owner = prepared;
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(prepared), { flag: 'wx' });
  } });
  let disposed = false;
  try {
    await until(() => existsSync(join(dir, 'child.json')));
    const child = JSON.parse(readFileSync(join(dir, 'child.json'), 'utf8'));
    const childPid = child.pid;
    let snapshot = [];
    await until(async () => { snapshot = await controller.snapshot(); return !snapshot.some(row => row.pid === owner.rootPid); });
    assert.ok(snapshot.some(row => row.pid === childPid && row.started === child.created), 'authoritative Job retains child after actual root exit');
    await controller.dispose(); disposed = true;
    assert.ok(controller.receipts.some(row => row.event === 'disposed' && row.activeProcesses === 0));
    assert.ok(controller.receipts.some(row => row.event === 'terminal' && row.ok === true));
    for (const identity of [child, { pid: owner.rootPid, created: owner.rootCreated }]) {
      assert.ok(['exited', 'notFound'].includes(observeExact(identity).state), 'exact native identity proves root and child retirement');
    }
  } finally {
    if (!disposed) await controller.dispose();
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ owner, packets: controller.receipts }, null, 2));
  }
});

test('#7036 failed durable Job persistence never resumes the actual suspended CPU root', { skip, timeout: 45000 }, async () => {
  const { dir, options, observeExact } = ownedFixture();
  let owner;
  await assert.rejects(launchOwnedJob({ ...options, async persistPrepared(prepared) {
    owner = prepared;
    assert.equal(existsSync(join(dir, 'root.started')), false);
    throw Error('Controlled durable owner write refusal');
  } }), /Controlled durable owner write refusal/);
  assert.ok(owner, 'actual prepared root identity was observed');
  assert.equal(existsSync(join(dir, 'root.started')), false, 'refused persistence cannot execute fixture code');
  const observation = observeExact({ pid: owner.rootPid, created: owner.rootCreated });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ owner, observation }, null, 2));
  assert.ok(['exited', 'notFound'].includes(observation.state), 'failed persistence retires the exact observed suspended root');
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

// #7221: actual suspended native resources, not mocked process lookup results.
// The callback is the real durable boundary; it keeps root code suspended while
// independent observers prove live identity and wrong-identity kill refusal.
for (const action of ['observe', 'terminate']) {
  test(`#7221 native ${action} rejects one-tick forged identity and proves actual state`, { skip, timeout: 60000 }, async context => {
    const fixture = ownedFixture();
    context.diagnostic('Owned CPU fixture ' + fixture.dir);
    let owner;
    const observations = [];
    let primary, protocolFailure, observerFailure, retired;
    try {
    await assert.rejects(launchOwnedJob({ ...fixture.options, async persistPrepared(prepared) {
      owner = prepared;
      writeFileSync(join(fixture.dir, 'owner.json'), JSON.stringify(prepared), { flag: 'wx' });
      const identity = { pid: prepared.rootPid, created: prepared.rootCreated };
      for (const expected of ['$null', "''"]) {
        assert.throws(() => powershell(`${fixture.identityPrelude}[IfcProcessIdentity]::ObserveExact(${identity.pid},${expected})|ConvertTo-Json -Compress`), /expected|creation identity/);
      }
      observations.push(fixture.observeExact(identity));
      assert.equal(observations.at(-1).state, 'live');
      assert.equal(observations.at(-1).started, identity.created);
      // Choose the adjacent tick in the SAME microsecond, including low digit 9.
      const actual = BigInt(identity.created);
      const forged = { ...identity, created: String(actual + (actual % 10n === 9n ? -1n : 1n)) };
      assert.throws(() => action === 'observe' ? fixture.observeExact(forged) : fixture.terminateExact(forged), /Exact native process identity mismatch/);
      observations.push(fixture.observeExact(identity));
      assert.equal(observations.at(-1).state, 'live', 'wrong creation stamp cannot retire the actual root');
      if (action === 'terminate') {
        observations.push(fixture.terminateExact(identity));
        assert.equal(observations.at(-1).state, 'exited', 'termination waits on the same held exact process handle');
      }
      throw Error('Controlled native identity boundary refusal');
    } }).catch(error => { protocolFailure = error; throw error; }), /Controlled native identity boundary refusal/);
    assert.ok(owner, 'actual prepared native root identity was observed');
    assert.equal(existsSync(join(fixture.dir, 'root.started')), false, 'identity control never executes unaccepted root code');
    } catch (error) { primary = error; }
    // Read is intentionally unbound and its native creation conversion is never
    // mutated. Strict JS comparison independently protects inverse cleanup proof.
    try {
      assert.ok(owner, 'actual prepared identity is required for final observation');
      retired = JSON.parse(powershell(`${fixture.identityPrelude}[IfcProcessIdentity]::Read(${owner.rootPid})|ConvertTo-Json -Compress`));
      if (retired.state !== 'notFound') {
        assert.equal(retired.started, owner.rootCreated, 'final native observation belongs to the exact prepared root');
        assert.equal(retired.state, 'exited');
      }
      assert.ok(protocolFailure instanceof OwnedJobProtocolError);
      assert.deepEqual(protocolFailure.retirement, { code: 1, signal: null });
      const terminal = protocolFailure.receipts.at(-1);
      assert.equal(terminal?.event, 'terminal');
      assert.equal(terminal?.ok, false);
      assert.equal(terminal?.failure?.cleanupError, undefined);
      assert.equal(terminal?.failure?.closeError, undefined);
    } catch (error) { observerFailure = error; }
    const receipt = { action, fixtureDirectory: fixture.dir, owner, observations, retired,
      primary: primary ? String(primary) : null, observerFailure: observerFailure ? String(observerFailure) : null,
      protocol: protocolFailure ? { packets: protocolFailure.receipts, retirement: protocolFailure.retirement,
        errors: [...protocolFailure.errors].map(String) } : null,
      scope: 'EOF failure terminal plus independent exact native retirement; no failure-branch active-zero packet claimed' };
    try { writeFileSync(join(fixture.dir, 'native-identity-receipt.json'), JSON.stringify(receipt, null, 2)); }
    catch (error) { observerFailure = observerFailure ? new AggregateError([observerFailure, error], 'Observer and evidence recording failed') : error; }
    if (primary && observerFailure) throw new AggregateError([primary, observerFailure], 'Primary control and exact retirement observation failed');
    if (primary) throw primary;
    if (observerFailure) throw observerFailure;
  });
}


// #7221/#7180: actual OS error events on the canonical supervisor spawn.
// No Windows provider is required; no prepared packets or root can exist.
for (const [code, errno] of [['ENOENT', -2], ['EACCES', -13]]) {
  test(`#7221 actual supervisor ${code} records explicit no-start event and matched close`, { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifc-job-no-start-'));
    const bin = join(dir, 'bin');mkdirSync(bin);
    if (code === 'EACCES') writeFileSync(join(bin, 'powershell.exe'), 'not executable', { mode: 0o644 });
    const before = process.env.PATH;process.env.PATH = bin;
    try {
      await assert.rejects(launchOwnedJob({ token: randomBytes(16).toString('hex'),
        executable: 'C:\\deliberately-unadmitted.exe', commandLine: 'deliberately unadmitted',
        supervisorWin: 'C:\\unadmitted-supervisor.ps1', jobModuleWin: 'C:\\unadmitted-job.cs', inputModuleWin: 'C:\\unadmitted-input.cs',
        requestMs: 1000, cleanupMs: 1000, lifetimeSeconds: 60,
        async persistPrepared() { assert.fail('A never-started supervisor cannot prepare a root'); },
      }), error => {
        assert.ok(error instanceof OwnedJobProtocolError);
        assert.deepEqual(error.receipts, []);
        assert.deepEqual(error.retirement, { code: errno, signal: null });
        assert.deepEqual(error.supervisorNoStart, { executable: 'powershell.exe', code, errno, syscall: 'spawn powershell.exe' });
        assert.ok(error.errors.some(primary => primary && typeof primary === 'object'
          && primary.code === code && primary.errno === errno && primary.syscall === 'spawn powershell.exe'), 'Primary actual native OS error remains inspectable');
        return true;
      });
    } finally { process.env.PATH = before;rmSync(dir, { recursive: true }); }
  });
}
