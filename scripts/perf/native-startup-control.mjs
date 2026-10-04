/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 real sample-startup admission; no IFC, timing verdict or guard bypass.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, statSync, lstatSync,
  openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execute, executeStartupControl, compilerEnvironment } from './native-hosted-process.mjs';
import { freshnessLog } from './native-hosted-plan.mjs';
import { repositoryNightlyChannel } from './native-hosted-prepare.mjs';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';
import { resolveCanonicalCargoShim, verifyCanonicalCargoResolution } from './native-cargo-resolution.mjs';
import { invalidateTargetQueryCache, ownedQueryFileCensus } from './native-query-cache.mjs';

const output = resolve(process.env.NATIVE_STARTUP_CONTROL_OUTPUT ?? 'native-results/startup-control');
mkdirSync(output, { recursive: true });
const report = { status: 'pending', scope: 'Real dependency-free Cargo-shim sample guard; no performance evidence' };
const save = () => writeFileSync(join(output, 'control.json'), JSON.stringify(report, null, 2));
const hash = value => createHash('sha256').update(value).digest('hex');
const probeCommand = ['bash', 'scripts/perf/probe.sh', 'startup-control', '--iters', '5', '--json', '--fingerprint'];
const contextPresence = environment => Object.fromEntries([
  'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'CARGO_HOME', 'RUSTC', 'RUSTDOC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER',
].map(name => [name, Object.hasOwn(environment, name)]));
function retainFinalCache(directory) {
  const path = join(directory, 'target/.rustc_info.json');
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent', path };
    throw error;
  }
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= 2097152,
    'final owned Cargo cache must be a bounded regular file');
  assert.equal(realpathSync(path), path, 'final cache must remain within the real owned sandbox');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino
      && opened.size === before.size && opened.mtimeMs === before.mtimeMs, 'final cache binding changed during open');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'final cache ended before its frozen size'); offset += count;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, 'final cache grew during bounded read');
    const after = fstatSync(fd), current = lstatSync(path);
    for (const observed of [after, current]) {
      assert.ok(observed.isFile() && !observed.isSymbolicLink() && observed.dev === opened.dev
        && observed.ino === opened.ino && observed.size === opened.size && observed.mtimeMs === opened.mtimeMs,
      'final cache binding changed during read');
    }
    const artifact = join(output, 'cache-after-sample.json');
    writeFileSync(artifact, bytes, { flag: 'wx' });
    return { status: 'retained', path, artifact, bytes: bytes.length, sha256: hash(bytes),
      fileIdentity: { dev: opened.dev, ino: opened.ino },
      scope: 'raw final Cargo cache before cleanup; opaque fingerprint and output keys are not reserialized' };
  } finally { closeSync(fd); }
}
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
    report.environmentContext = { scope: 'parent presence and explicit compiler selection, not Rustup child environment',
      inheritedPresence: contextPresence(process.env), selectedPresence: contextPresence(environment),
      explicitSelection: { rustc: tools.rustc, rustdoc: tools.rustdoc, toolchain: tools.toolchain },
      controlled: { OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' } };
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
    // Warm and sample use the SAME canonical Bash/probe/Rustup entrypoint,
    // purpose, arguments and compiler environment; only observation policy differs.
    report.warm = await execute(probeCommand, sandbox, join(output, 'warm'), { tools, wallMs: 60000 });
    assert.equal(report.warm.status, 'complete', report.warm.reason); save();
    assert.deepEqual(report.warm.observationPolicy, { scope: 'normal-native-execution', intervalMs: 250 });
    // Keep the real warm cached -vV output so its synchronous observer proof
    // cannot hide the following short target query. Only this OWN cache's unique
    // observed target output is invalidated; source/command/timers are unchanged.
    const versionCache = join(sandbox, 'target/.rustc_info.json');
    const cacheStat = lstatSync(versionCache);
    assert.ok(cacheStat.isFile() && !cacheStat.isSymbolicLink() && cacheStat.size > 0 && cacheStat.size <= 2097152,
      'bounded real owned Cargo cache required');
    assert.equal(realpathSync(versionCache), versionCache, 'cache path must be within the fresh real sandbox');
    const cacheBefore = readFileSync(versionCache);
    writeFileSync(join(output, 'cache-before.json'), cacheBefore, { flag: 'wx' });
    const targetArgs = ['-', '--crate-name', '___', '--print=file-names',
      '--crate-type', 'bin', '--crate-type', 'rlib', '--crate-type', 'dylib',
      '--crate-type', 'cdylib', '--crate-type', 'staticlib', '--crate-type', 'proc-macro',
      '--print=sysroot', '--print=split-debuginfo', '--print=crate-name', '--print=cfg', '-Wwarnings'];
    const actualQueries = {};
    for (const [kind, args] of [['version', ['-vV']], ['cargo-target-info', targetArgs]]) {
      assert.ok(sameNativeFile(nativeFileIdentity(tools.rustc), tools.rustcFileIdentity), 'direct query frozen compiler inode');
      const beforeHash = hash(readFileSync(tools.rustc));
      assert.equal(beforeHash, tools.rustcSha256, 'direct query uses actual frozen compiler bytes');
      const queryEnvironment = { ...environment };
      if (kind === 'cargo-target-info') delete queryEnvironment.RUSTC_LOG; // Pinned Cargo TargetInfo::new does the same.
      const filesBefore = ownedQueryFileCensus(sandbox);
      const result = spawnSync(tools.rustc, args, { cwd: sandbox, env: queryEnvironment, input: '',
        encoding: 'utf8', timeout: 15000, maxBuffer: 131072 });
      const filesAfter = ownedQueryFileCensus(sandbox);
      actualQueries[kind] = { argv: [tools.rustc, ...args], status: result.status, signal: result.signal,
        stdout: result.stdout, stderr: result.stderr, error: result.error?.message,
        ownedFilesBefore: filesBefore, ownedFilesAfter: filesAfter,
        frozenCompilerSha256: beforeHash, afterCompilerSha256: hash(readFileSync(tools.rustc)) };
      writeFileSync(join(output, 'direct-query-results.json'), JSON.stringify(actualQueries, null, 2));
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
      assert.deepEqual(filesAfter, filesBefore, 'direct read-only query leaves no changed or additional owned files');
      assert.equal(actualQueries[kind].afterCompilerSha256, tools.rustcSha256);
      assert.ok(sameNativeFile(nativeFileIdentity(tools.rustc), tools.rustcFileIdentity), 'direct query compiler inode unchanged');
    }
    assert.deepEqual(readFileSync(versionCache), cacheBefore, 'direct queries cannot alter the actual Cargo cache');
    const selected = invalidateTargetQueryCache(cacheBefore, actualQueries['cargo-target-info'], actualQueries.version);
    const selectedStat = lstatSync(versionCache);
    assert.ok(selectedStat.isFile() && !selectedStat.isSymbolicLink()
      && selectedStat.ino === cacheStat.ino && selectedStat.dev === cacheStat.dev
      && selectedStat.size === cacheBefore.length, 'owned cache binding cannot change during selection');
    writeFileSync(versionCache, selected.after);
    assert.deepEqual(readFileSync(versionCache), selected.after);
    writeFileSync(join(output, 'cache-after.json'), selected.after, { flag: 'wx' });
    report.versionProbeControl = { versionCache, mode: 'selective-owned-target-output',
      ...selected.receipt, observationPolicy: 'actual target query live ownership proof required; unobserved query refuses' };
    save();
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
    report.sample = await executeStartupControl(probeCommand,
      sandbox, join(output, 'sample'), { sample: true, tools, wallMs: 15000 });
    save();
    assert.deepEqual(report.sample.observationPolicy, { scope: 'startup-control-only', intervalMs: 2 });
    const [lockExit, lockSignal] = await holderClosed;
    report.lockHolderExit = { code: lockExit, signal: lockSignal, stderr: lockError }; save();
    assert.equal(report.sample.status, 'complete', report.sample.reason);
    assert.equal(lockExit, 0, lockError);
    assert.ok(report.sample.cargoExceptions.length > 0, 'real Cargo freshness process must actually be observed and admitted');
    assert.ok(report.sample.versionProbeExceptions.length > 0,
      'actual Cargo read-only child was not witnessed; cannot qualify the compiler-child admission');
    assert.ok(report.sample.versionProbeExceptions.some(row => row.queryKind === 'cargo-target-info'),
      'actual Cargo target-information query must be witnessed with complete positive ownership proof');
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
  if (sandbox) {
    try {
      report.cacheAfterSample = retainFinalCache(sandbox);
      if (report.sample) assert.equal(report.cacheAfterSample.status, 'retained', 'actual sample final Cargo cache must be retained');
    } catch (error) {
      report.cacheAfterSample = { status: 'refused', reason: String(error) };
      if (report.status !== 'refused') { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
    }
  }
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  report.ownedTemporaryCrateRemoved = Boolean(sandbox); save();
  console.log(JSON.stringify({ status: report.status, reason: report.reason, output }));
}
