/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 real sample-startup admission; no IFC, timing verdict or guard bypass.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execute, executeStartupControl, compilerEnvironment } from './native-hosted-process.mjs';
import { cargoArgs, freshnessLog } from './native-hosted-plan.mjs';
import { repositoryNightlyChannel } from './native-hosted-prepare.mjs';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';
import { resolveCanonicalCargoShim, verifyCanonicalCargoResolution } from './native-cargo-resolution.mjs';

const output = resolve(process.env.NATIVE_STARTUP_CONTROL_OUTPUT ?? 'native-results/startup-control');
mkdirSync(output, { recursive: true });
const report = { status: 'pending', scope: 'Real dependency-free Cargo-shim sample guard; no performance evidence' };
const save = () => writeFileSync(join(output, 'control.json'), JSON.stringify(report, null, 2));
const hash = value => createHash('sha256').update(value).digest('hex');
let sandbox, holder, holderClosed;
try {
  const channel = repositoryNightlyChannel();
  const tools = {};
  for (const name of ['cargo', 'rustc', 'rustdoc']) {
    const result = spawnSync('rustup', ['which', '--toolchain', channel, name], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0 || result.error) {
      report.status = 'skipped'; report.reason = `repository-pinned ${name} unavailable: ${result.stderr || result.error}`;
      if (process.env.NATIVE_COMPILER_CONTROL_REQUIRED === '1') throw new Error(report.reason);
      break;
    }
    tools[name] = realpathSync(result.stdout.trim());
  }
  if (report.status !== 'skipped') {
    for (const name of ['bash', 'rustup']) {
      const found = spawnSync('which', [name], { encoding: 'utf8', timeout: 30000 });
      assert.equal(found.status, 0, found.stderr);
      tools[name === 'rustup' ? 'selectionRustup' : name] = realpathSync(found.stdout.trim());
    }
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ifc-native-startup-')));
    tools.toolchain = basename(dirname(dirname(tools.rustc)));
    const environment = compilerEnvironment({ ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, tools);
    report.cargoShimResolution = await resolveCanonicalCargoShim({ bash: tools.bash, directory: sandbox, environment });
    tools.rustup = report.cargoShimResolution.after.cargo.realPath;
    report.shim = report.cargoShimResolution.after.cargo.commandPath;
    tools.rustupFileIdentity = nativeFileIdentity(tools.rustup);
    for (const name of ['rustup', 'cargo', 'rustc']) {
      tools[`${name}FileIdentity`] = nativeFileIdentity(tools[name]);
      tools[`${name}Sha256`] = hash(readFileSync(tools[name]));
      tools[`${name}FileBytes`] = statSync(tools[name]).size;
    }
    report.tools = tools;
    report.frozenRustup = { path: tools.rustup, fileIdentity: tools.rustupFileIdentity,
      sha256: hash(readFileSync(tools.rustup)) };
    mkdirSync(join(sandbox, 'scripts/perf'), { recursive: true }); mkdirSync(join(sandbox, 'examples'));
    const probe = readFileSync(new URL('./probe.sh', import.meta.url));
    const manifest = '[package]\nname="ifc-lite-processing"\nversion="0.0.0"\nedition="2021"\n[profile.profiling]\ninherits="release"\ndebug="line-tables-only"\nstrip=false\n';
    const example = 'fn main() { assert_eq!(7u64.checked_mul(9), Some(63)); std::thread::sleep(std::time::Duration::from_millis(800)); println!("canonical startup control executed"); }\n';
    writeFileSync(join(sandbox, 'Cargo.toml'), manifest);
    writeFileSync(join(sandbox, 'examples/perf_probe.rs'), example);
    writeFileSync(join(sandbox, 'scripts/perf/probe.sh'), probe);
    report.sources = { probeSha256: hash(probe), manifestSha256: hash(manifest), exampleSha256: hash(example), sandbox };
    report.warm = await execute(['cargo', ...cargoArgs, '--offline'], sandbox, join(output, 'warm'), { tools, wallMs: 60000 });
    assert.equal(report.warm.status, 'complete', report.warm.reason); save();
    // Only this owned temp target's version cache is removed. The real Cargo
    // must query the actual frozen rustc; no wrapper or compiler flags change.
    const versionCache = join(sandbox, 'target/.rustc_info.json');
    report.versionProbeControl = { versionCache, removed: false, observationPolicy: 'actual complete live ownership proof required; unobserved probe is refusal' };
    try {
      report.versionProbeControl.previousSha256 = hash(readFileSync(versionCache));
      rmSync(versionCache); report.versionProbeControl.removed = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Cargo's real lock exposes its no-op build to the startup-only 2ms monitor.
    // The lock holder is finite, owned and not a compiler. No source is changed.
    const lock = join(sandbox, 'target/profiling/.cargo-lock');
    const lockScript = 'import fcntl,sys,time\nf=open(sys.argv[1],"r+")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(1.25)\n';
    holder = spawn('/usr/bin/python3', ['-c', lockScript, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
    holderClosed = once(holder, 'close');
    let lockError = ''; holder.stderr.on('data', data => { lockError += data.toString(); });
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error('owned lock readiness deadline')), 5000);
      holder.stdout.once('data', data => {
        clearTimeout(timer);
        if (data.toString().trim() === 'locked') accept();
        else reject(new Error('lock readiness refused'));
      });
      holder.once('error', error => { clearTimeout(timer); reject(error); });
      holder.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`lock holder ${code}: ${lockError}`)); });
    });
    report.lockControl = { tool: '/usr/bin/python3', sourceSha256: hash(lockScript), holdMs: 1250, lock };
    report.sample = await executeStartupControl(['bash', 'scripts/perf/probe.sh', 'startup-control', '--iters', '5', '--json', '--fingerprint'],
      sandbox, join(output, 'sample'), { sample: true, tools, wallMs: 15000 });
    save();
    assert.deepEqual(report.sample.observationPolicy, { scope: 'startup-control-only', intervalMs: 2 });
    const [lockExit, lockSignal] = await holderClosed;
    report.lockHolderExit = { code: lockExit, signal: lockSignal, stderr: lockError }; save();
    assert.equal(report.sample.status, 'complete', report.sample.reason);
    assert.equal(lockExit, 0, lockError);
    assert.ok(report.sample.cargoExceptions.length > 0, 'real Cargo freshness process must actually be observed and admitted');
    assert.ok(report.sample.versionProbeExceptions.length > 0,
      'actual Cargo version child was not witnessed; cannot qualify the new compiler-child admission');
    freshnessLog(readFileSync(report.sample.paths.stderr, 'utf8'));
    assert.equal(readFileSync(report.sample.paths.stdout, 'utf8'), 'canonical startup control executed\n');
    report.status = 'complete-real-startup-control';
  }
} catch (error) {
  report.status = 'refused'; report.reason = String(error); process.exitCode = 1;
  if (error.resolutionReceipt) report.cargoShimResolutionRefusal = error.resolutionReceipt;
} finally {
  if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  if (holderClosed) {
    const [code, signal] = await holderClosed;
    report.lockHolderExit = { ...report.lockHolderExit, code, signal };
  }
  if (report.frozenRustup) {
    try {
      await verifyCanonicalCargoResolution(report.cargoShimResolution);
      const actual = { fileIdentity: nativeFileIdentity(report.frozenRustup.path),
        sha256: hash(readFileSync(report.frozenRustup.path)) };
      assert.ok(sameNativeFile(actual.fileIdentity, report.frozenRustup.fileIdentity), 'frozen rustup file identity changed');
      assert.equal(actual.sha256, report.frozenRustup.sha256, 'frozen rustup executable bytes changed');
      for (const name of ['rustup', 'cargo', 'rustc']) {
        assert.equal(statSync(report.tools[name]).size, report.tools[`${name}FileBytes`], `frozen ${name} size changed`);
        assert.ok(sameNativeFile(nativeFileIdentity(report.tools[name]), report.tools[`${name}FileIdentity`]), `frozen ${name} identity changed`);
        assert.equal(hash(readFileSync(report.tools[name])), report.tools[`${name}Sha256`], `frozen ${name} bytes changed`);
      }
      report.frozenRustupFinalVerification = { status: 'complete', ...actual };
    } catch (error) {
      report.frozenRustupFinalVerification = { status: 'refused', reason: String(error) };
      if (report.status !== 'refused') { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
    }
  }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  report.ownedTemporaryCrateRemoved = Boolean(sandbox); save();
  console.log(JSON.stringify({ status: report.status, reason: report.reason, output }));
}
