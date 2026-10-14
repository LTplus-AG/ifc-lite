/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { runNativeNight, type NativeNightOptions } from '../../../../../scripts/perf/frame-gpu-night-controller.js';
import { readNightAttempts } from '../../../../../scripts/perf/frame-gpu-night-attempt.js';
import { nightHistoryWindow } from '../../../../../scripts/perf/frame-gpu-night-history.js';
import { requireNightLease, requireNightWindow, watchNightLease, type NightAuthority } from '../../../../../scripts/perf/frame-gpu-night-lease.js';
import { runNightProcess } from '../../../../../scripts/perf/frame-gpu-night-process.js';
import { acquireNightLease } from '../../../../../scripts/perf/frame-gpu-night-acquire.js';
import { sha256 } from '../../../../../scripts/perf/frame-gpu-night-profile.js';

// #6975 CPU/filesystem/process protocol controls only. No GPU implementation,
// shader, browser, timing result or provider is substituted. The real child
// canary deliberately exits2, so it can NEVER create an accepted native night.
async function fixture(context: TestContext, run: (value: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  // Freeze only the CPU protocol calendar, never a browser/provider/result.
  // This keeps controls independent of the real runner's UTC-midnight boundary.
  context.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T20:05:01Z') });
  const value = createFixture();
  try { await run(value); }
  finally { rmSync(value.root, { recursive: true, force: true }); context.mock.timers.reset(); }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), '6975-night-controller-')), checkout = join(root, 'checkout');
  mkdirSync(checkout);
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\n', 'rust/source.txt': 'CPU source-identity invariant fixture\n',
    'apps/viewer/dist/index.html': '<html>CPU source profile fixture, no viewer</html>',
    'packages/wasm/pkg/ifc-lite_bg.wasm': 'CPU byte-fence fixture, not WASM',
    'packages/wasm/pkg/ifc-lite.js': '// CPU byte-fence fixture, never imported',
    'packages/wasm/pkg/ifc-lite.d.ts': '// CPU byte-fence fixture',
    'fixture.ifc': "ISO-10303-21;HEADER;FILE_DESCRIPTION(('CPU byte-fence invariant'),'2;1');FILE_NAME('','',(),(),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#1=IFCPROJECT('0AAAAAAAAAAAAAAAAAAAAA',$,'CPU control',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;",
    'qualification.json': JSON.stringify({ scope: 'CPU protocol fixture; no native GPU qualification' }),
    'scripts/perf/frame-gpu-rig.mts': '// CPU canary path only; production rig is not replaced in this repository',
    'host.json': JSON.stringify({ version: 1,
      browser: { executable: process.execPath, sha256: sha256(readFileSync(process.execPath)), version: process.version, executableWin: 'C:\\CPU-controller-fixture.exe' },
      adapter: { vendor: 'CPU protocol fixture', architecture: 'not native GPU evidence' },
      viewport: { cssWidth: 1, cssHeight: 1, pixelWidth: 1, pixelHeight: 1, dpr: 1 },
      output: { monitor: 'CPU protocol fixture', left: 0, top: 0, width: 1, height: 1,
        frequencyHz: 2, bitsPerPixel: 24, orientation: 0, dpi: 96,
        controllers: [{ name: 'CPU protocol fixture', device: 'not-a-GPU', driver: 'not-a-driver' }] }, minimumUserIdleSeconds: 1 }),
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(checkout, path, '..'), { recursive: true }); writeFileSync(join(checkout, path), bytes);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=CPU Protocol Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'CPU protocol fixture');
  const profile = { version: 1, sourceHead: git('rev-parse', 'HEAD'), rustTree: git('rev-parse', 'HEAD:rust'),
    dist: 'apps/viewer/dist', fixture: 'fixture.ifc', hostProfile: 'host.json', qualificationReceipt: 'qualification.json',
    artifacts: Object.keys(files).filter(path => !path.startsWith('rust/') && !path.startsWith('scripts/') && path !== '.gitignore')
      .map(path => ({ path, sha256: sha256(readFileSync(join(checkout, path))) })) };
  const profileFile = join(root, 'profile.json'); writeFileSync(profileFile, JSON.stringify(profile));
  // Actual executable child records its received argv and exits2. It produces
  // no fabricated native sample; only the guarded invocation is exercised.
  const loader = join(checkout, 'node_modules/tsx/dist/cli.mjs'); mkdirSync(join(loader, '..'), { recursive: true });
  writeFileSync(loader, "console.log(JSON.stringify({scope:'CPU launch canary only',argv:process.argv.slice(2)}));process.exitCode=2;\n");
  const now = new Date(), startsAt = new Date(now.getTime() - 1000).toISOString(), endsAt = new Date(now.getTime() + 19 * 60_000).toISOString();
  const options: NativeNightOptions = { checkout, profileFile, profileSha256: sha256(readFileSync(profileFile)),
    outputRoot: join(root, 'evidence'), leaseFile: join(root, 'lease.json'), night: now.toISOString().slice(0, 10), startsAt, endsAt };
  const grant = { approved: true, issue: 6975, activeAgent: 'CPU protocol fixture', sourceHead: profile.sourceHead,
    profileSha256: options.profileSha256, night: options.night, startsAt, endsAt };
  const owner = { pid: process.pid, activeAgent: grant.activeAgent, worktree: checkout, executionGrant: true, nightExecutionGrant: grant };
  writeFileSync(options.leaseFile, JSON.stringify(owner));
  const authority: NightAuthority = { ...options, sourceHead: profile.sourceHead };
  return { root, checkout, options, owner, authority };
}

test('#6975 controller refuses a foreign heavy owner before any child and preserves its record', (context) => fixture(context, async x => {
  writeFileSync(x.options.leaseFile, JSON.stringify({ ...x.owner, activeAgent: 'foreign live work' }));
  const original = readFileSync(x.options.leaseFile), result = await runNativeNight(x.options);
  assert.equal(result.attempt.status, 'refused');
  assert.match(JSON.parse(readFileSync(join(result.directory, 'completed-receipt.json'), 'utf8')).error, /execution grant missing/);
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
  assert.deepEqual(readFileSync(x.options.leaseFile), original);
  assert.equal(nightHistoryWindow(readNightAttempts(x.options.outputRoot), result.attempt.night).calendarReady, false);
}));

test('#6975 late scheduled invocation cannot catch up or launch a browser', (context) => fixture(context, async x => {
  const result = await runNativeNight({ ...x.options, startsAt: new Date(Date.now() - 120_000).toISOString() });
  assert.equal(result.attempt.status, 'refused');
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
  assert.equal(result.calendarReady, false);
}));

test('#6975 missing immutable profile still leaves the original failed nightly receipt', (context) => fixture(context, async x => {
  const result = await runNativeNight({ ...x.options, profileFile: join(x.root, 'missing-profile.json') });
  assert.equal(result.attempt.status, 'failed');
  assert.equal(readNightAttempts(x.options.outputRoot)[0].status, 'failed');
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
}));

test('#6975 duplicate invocation never upgrades a refused day or reaches the real child', (context) => fixture(context, async x => {
  writeFileSync(x.options.leaseFile, JSON.stringify({ ...x.owner, executionGrant: false }));
  const first = await runNativeNight(x.options);
  writeFileSync(x.options.leaseFile, JSON.stringify(x.owner));
  const retry = await runNativeNight(x.options);
  assert.equal(first.attempt.status, 'refused'); assert.equal(retry.attempt.status, 'refused');
  assert.equal(existsSync(join(retry.directory, 'rig-process.json')), false);
  assert.equal(nightHistoryWindow(readNightAttempts(x.options.outputRoot), retry.attempt.night).reason, 'multiple attempts on one night');
}));

test('#6975 modified real checkout artifact refuses before the invocation can start', (context) => fixture(context, async x => {
  writeFileSync(join(x.checkout, 'apps/viewer/dist/index.html'), 'changed actual artifact');
  const result = await runNativeNight(x.options);
  assert.equal(result.attempt.status, 'failed');
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
  assert.match(JSON.parse(readFileSync(join(result.directory, 'completed-receipt.json'), 'utf8')).error, /dirty|artifact changed/);
}));

test('#6975 actual CPU child receives strict native argv but cannot become an accepted night', (context) => fixture(context, async x => {
  const result = await runNativeNight(x.options);
  assert.equal(result.attempt.status, 'failed'); assert.equal(result.calendarReady, false);
  const process = JSON.parse(readFileSync(join(result.directory, 'rig-process.json'), 'utf8'));
  assert.equal(process.exit, 2); assert.deepEqual(process.liveOwned, []);
  const canary = JSON.parse(readFileSync(join(result.directory, 'rig.stdout'), 'utf8'));
  assert.equal(canary.scope, 'CPU launch canary only');
  for (const flag of ['--require-gpu-timing', '--require-physical-display', '--require-host-idle', '--night-profile', '--owner-ledger']) {
    assert.ok(canary.argv.includes(flag), `actual child must receive ${flag}`);
  }
  assert.equal(canary.argv[canary.argv.indexOf('--pairs') + 1], '1');
  const receipt = join(result.directory, 'completed-receipt.json'); writeFileSync(receipt, 'altered raw actual receipt');
  assert.throws(() => readNightAttempts(x.options.outputRoot), /raw receipt changed/);
}));

test('#6975 lease restoration cannot erase an observed ownership interruption', (context) => fixture(context, async x => {
  requireNightLease(x.options.leaseFile, x.authority);
  const cancel = new AbortController(), monitor = watchNightLease(x.options.leaseFile, x.authority, cancel);
  writeFileSync(x.options.leaseFile, JSON.stringify({ ...x.owner, activeAgent: 'foreign live work' }));
  await pause(350);
  writeFileSync(x.options.leaseFile, JSON.stringify(x.owner));
  const observed = monitor.stop();
  assert.equal(cancel.signal.aborted, true); assert.ok(observed.interruptions > 0);
  assert.match(observed.firstError ?? '', /execution grant missing/);
}));

test('#6975 actual owned CPU process ignores TERM and is bounded without touching foreign groups', async () => {
  const directory = mkdtempSync(join(tmpdir(), '6975-process-bound-'));
  try {
    const result = await runNightProcess({ argv: [process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      cwd: directory, directory, budgetMs: 250, cleanupMs: 250 });
    assert.equal(result.timedOut, true); assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(result.liveOwned, []); assert.ok(result.pid && result.observed.some(row => row.pid === result.pid));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('#6975 explicit UTC night refuses windows crossing into another scheduled date', () => {
  assert.throws(() => requireNightWindow({ night: '2026-10-13', startsAt: '2026-10-13T23:59:00Z', endsAt: '2026-10-14T00:01:00Z' },
    new Date('2026-10-13T23:59:30Z')), /invalid explicit bounded UTC/);
});

// These explicit dates are a frozen CPU protocol fixture, not scheduled native
// nights or an assertion that the actual reservation includes these dates.
function standing(x: ReturnType<typeof createFixture>) {
  const windows = Array.from({ length: 7 }, (_, index) => ({
    night: new Date(Date.parse(x.options.startsAt) + index * 86_400_000).toISOString().slice(0, 10),
    startsAt: new Date(Date.parse(x.options.startsAt) + index * 86_400_000).toISOString(),
    endsAt: new Date(Date.parse(x.options.endsAt) + index * 86_400_000).toISOString(),
  }));
  const leaseFile = join(x.root, 'shared-heavy.lock', 'owner.json');
  const grant = { version: 1, approved: true, issue: 6975, approvedAt: new Date(Date.now() - 60_000).toISOString(),
    checkout: x.checkout, leaseFile, sourceHead: x.authority.sourceHead, profileSha256: x.options.profileSha256,
    reservation: { startsAt: windows[0].startsAt, endsAt: windows[6].endsAt }, windows };
  const path = join(x.root, 'standing-authorization.json'); writeFileSync(path, JSON.stringify(grant));
  return { leaseFile, grant, authorization: { path, sha256: sha256(readFileSync(path)) } };
}

test('#6975 standing night atomically excludes a second coordinator without a long-lived Root PID', (context) => fixture(context, async x => {
  const supplied = standing(x);
  const owned = acquireNightLease({ ...supplied, authority: x.authority });
  assert.equal(requireNightLease(supplied.leaseFile, x.authority).pid, process.pid);
  assert.throws(() => acquireNightLease({ ...supplied, authority: x.authority }), /already reserved/);
  // No child was invoked; this known finite coordinator may release its own
  // unchanged directory. This real filesystem exclusion is not GPU evidence.
  owned.release(); assert.equal(existsSync(join(x.root, 'shared-heavy.lock')), false);
}));

test('#6975 standing acquisition never replaces an existing released or apparently dead lane', (context) => fixture(context, async x => {
  const supplied = standing(x); mkdirSync(join(x.root, 'shared-heavy.lock'));
  const bytes = JSON.stringify({ pid: 2147483647, executionGrant: false, activeAgent: 'foreign historical owner' });
  writeFileSync(supplied.leaseFile, bytes);
  const result = await runNativeNight({ ...x.options, leaseFile: supplied.leaseFile, authorization: supplied.authorization });
  assert.equal(result.attempt.status, 'refused');
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
  assert.equal(readFileSync(supplied.leaseFile, 'utf8'), bytes);
  assert.equal(result.calendarReady, false);
}));

test('#6975 owned atomic lease release refuses an intervening foreign owner and keeps its bytes', (context) => fixture(context, async x => {
  const supplied = standing(x);
  const owned = acquireNightLease({ ...supplied, authority: x.authority });
  const bytes = JSON.stringify({ activeAgent: 'foreign replacement', executionGrant: true });
  writeFileSync(supplied.leaseFile, bytes);
  assert.throws(() => owned.release(), /lease changed/);
  assert.equal(readFileSync(supplied.leaseFile, 'utf8'), bytes);
}));

test('#6975 standing grant cannot extend its approved reservation', (context) => fixture(context, async x => {
  const supplied = standing(x);
  supplied.grant.reservation.endsAt = supplied.grant.windows[5].endsAt;
  writeFileSync(supplied.authorization.path, JSON.stringify(supplied.grant));
  supplied.authorization.sha256 = sha256(readFileSync(supplied.authorization.path));
  const result = await runNativeNight({ ...x.options, leaseFile: supplied.leaseFile, authorization: supplied.authorization });
  assert.equal(result.attempt.status, 'refused');
  assert.equal(existsSync(join(x.root, 'shared-heavy.lock')), false);
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
}));


test('#6975 standing authorization cannot retroactively approve its first nightly window', (context) => fixture(context, async x => {
  const supplied = standing(x); supplied.grant.approvedAt = supplied.grant.windows[0].startsAt;
  writeFileSync(supplied.authorization.path, JSON.stringify(supplied.grant));
  supplied.authorization.sha256 = sha256(readFileSync(supplied.authorization.path));
  const result = await runNativeNight({ ...x.options, leaseFile: supplied.leaseFile, authorization: supplied.authorization });
  assert.equal(result.attempt.status, 'refused');
  assert.equal(existsSync(join(x.root, 'shared-heavy.lock')), false);
  assert.equal(existsSync(join(result.directory, 'rig-process.json')), false);
}));


test('#6975 absent native ledger after a real child is not adopted as retirement proof', (context) => fixture(context, async x => {
  const supplied = standing(x);
  const result = await runNativeNight({ ...x.options, leaseFile: supplied.leaseFile, authorization: supplied.authorization });
  assert.equal(result.attempt.status, 'failed'); assert.equal(result.calendarReady, false);
  const receipt = JSON.parse(readFileSync(join(result.directory, 'completed-receipt.json'), 'utf8'));
  assert.equal(receipt.process.exit, 2); assert.deepEqual(receipt.process.liveOwned, []);
  assert.equal(receipt.atomicRelease.released, false); assert.equal(receipt.atomicRelease.quarantined, true);
  assert.ok(existsSync(supplied.leaseFile));
}));
