/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Released-artifact smoke for the retained-geometry release (#7955).
 *
 * Installs ONLY from the public registries (npm, crates.io, PyPI) into a clean
 * temporary project OUTSIDE this repository, with empty npm/pip configuration
 * and a private CARGO_HOME, so no workspace path, link, patch or local config can
 * leak in. It never publishes or changes registry state.
 *
 *   node scripts/smoke-released-retained.mjs --wasm 12.1.0 --cli 0.44.0 \
 *        --crate 27.1.0 [--wheel latest|X.Y.Z|skip] [--toolchain NAME] [--strict]
 *        [--out summary.json] [--keep]
 *
 * npm versions accept `latest` (resolved and recorded). Cargo outside the repo
 * does not see rust-toolchain.toml, so the toolchain is passed explicitly:
 * --toolchain, else RUSTUP_TOOLCHAIN, else the channel pinned in the repo's
 * rust-toolchain.toml. The toolchain, its source and `cargo -V` are recorded in
 * the JSON. Untrusted registry code (the WASM glue, `retained.js`) runs only in
 * child processes with a cleaned environment: no registry or CI tokens.
 *
 * --strict is the release sign-off mode: any skipped step (crate builds, wheel,
 * retained export) is a failure.
 *
 * A locally staged engine directory (scripts/stage-cli-retained-engine.mjs
 * output) enables the end-to-end retained export step through the PUBLISHED
 * CLI: pass --retained-engine DIR or IFCLITE_SMOKE_RETAINED_ENGINE. Without
 * it that step is reported `skip` ("not run"), never `pass`.
 *
 * Every step is `pass`, `fail` or `skip` in the JSON summary; exit code is 1
 * when any step failed (skips alone do not fail the run).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';
import {
  PROBE_FLAG, RETAINED_PROBE_FLAG, WHEEL_PYTHON_FLAGS, chooseToolchain, parseArgs, retainedEngineFrom, retainedProbe, walkFiles, wasmProbe, wheelProbeArgv,
} from './lib/released-smoke-support.mjs';
import {
  EXPECTED_REPO, EXPECTED_WORKFLOW, NPM_REGISTRY, auditProblems, boundaryViolations, cargoLockProblems, contentViolation,
  crateManifestProblems, engineEvidence, isInside, lockChecksum, noticeProblems, npmLockProblems, provenanceProblems, retainedAbsent, selectWheel, verifiedAttestations,
  stripArchiveRoot, summarize,
} from './lib/released-smoke-checks.mjs';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CRATES_STATIC = 'https://static.crates.io/crates';
const CRATE = 'ifc-lite-geometry-runtime';

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function run(file, args, { cwd, env, timeout = 600_000, input } = {}) {
  const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout, input, maxBuffer: 256 * 1024 * 1024 });
  return {
    ok: result.status === 0 && !result.error && !result.signal,
    status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    error: result.error?.message ?? (result.signal ? `signal ${result.signal}` : undefined),
  };
}
const tail = (r, n = 600) => (r.error ?? '') + (r.stderr + r.stdout).trim().slice(-n);

// ---------------------------------------------------------------------------
// Smoke
// ---------------------------------------------------------------------------


export async function smoke(options, log = (m) => process.stderr.write(`${m}\n`)) {
  const fixture = resolve(options.fixture ?? join(REPO, 'tests/fixtures/cli-retained/layered-wall.ifc'));
  const retainedEngine = retainedEngineFrom(options);
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'ifc-lite-released-smoke-')));
  const steps = [];
  const step = async (id, fn) => {
    const started = Date.now();
    let record;
    try {
      const r = await fn();
      record = r.skip ? { id, status: 'skip', detail: r.skip } : { id, status: r.fail ? 'fail' : (r.status ?? 'pass'), detail: r.fail ?? r.detail, evidence: r.evidence };
    } catch (error) {
      record = { id, status: 'fail', detail: error?.message ?? String(error) };
    }
    if (options.strict && record.status === 'skip') {
      record = { id, status: 'fail', detail: `skipped under --strict: ${record.detail}`, skipped: true };
    }
    record.ms = Date.now() - started;
    log(`${record.status.toUpperCase().padEnd(4)} ${id}${record.detail ? `: ${String(record.detail).split('\n')[0]}` : ''}`);
    steps.push(record);
    return record;
  };

  const toolchain = chooseToolchain(options, REPO);
  const scratchHome = join(work, 'home');
  mkdirSync(scratchHome);
  const emptyConfig = join(work, 'empty.npmrc');
  const emptyGlobalConfig = join(work, 'empty-global.npmrc');
  writeFileSync(emptyConfig, '');
  writeFileSync(emptyGlobalConfig, '');
  const env = {
    // Registry code (npm, wasm glue, CLI, build scripts, wheel) sees a scratch HOME, never ~/.npmrc or ~/.cargo/credentials.
    PATH: process.env.PATH, HOME: scratchHome, LANG: 'C', CI: '1',
    npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyGlobalConfig,
    npm_config_registry: NPM_REGISTRY, npm_config_update_notifier: 'false',
    npm_config_cache: join(work, 'npm-cache'),
    CARGO_HOME: join(work, 'cargo-home'), CARGO_TARGET_DIR: join(work, 'cargo-target'),
    ...(toolchain.name ? { RUSTUP_TOOLCHAIN: toolchain.name } : {}),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME ?? '', '.rustup'),
  };
  const resolved = {};
  const resolveNpm = (name, wanted) => {
    if (wanted !== 'latest') return wanted;
    const r = run('npm', ['view', name, 'version'], { cwd: work, env });
    if (!r.ok) throw new Error(`cannot resolve ${name}@latest: ${tail(r)}`);
    return r.stdout.trim();
  };

  try {
    await step('isolation', () => {
      if (isInside(REPO, work)) return { fail: `scratch ${work} is inside the repository` };
      return { detail: `scratch project ${work} is outside ${REPO}; empty npm config, scratch HOME, private CARGO_HOME` };
    });

    resolved.crate = options.crate;
    const versions = await step('resolve-versions', () => {
      resolved.wasm = resolveNpm('@ifc-lite/wasm', options.wasm);
      resolved.cli = resolveNpm('@ifc-lite/cli', options.cli);
      return { detail: `@ifc-lite/wasm@${resolved.wasm}, @ifc-lite/cli@${resolved.cli}, ${CRATE}@${resolved.crate}` };
    });
    if (versions.status !== 'pass') return finish();

    // ---- npm: install only from the public registry ----------------------------------
    const project = join(work, 'consumer');
    mkdirSync(project);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'released-smoke-consumer', private: true, version: '0.0.0' }));
    const lockIntegrity = {};
    const installed = await step('npm-install', () => {
      const r = run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', NPM_REGISTRY, '--save-exact',
        `@ifc-lite/wasm@${resolved.wasm}`, `@ifc-lite/cli@${resolved.cli}`], { cwd: project, env });
      if (!r.ok) return { fail: tail(r) };
      const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
      for (const name of ['@ifc-lite/wasm', '@ifc-lite/cli']) lockIntegrity[name] = lock.packages?.[`node_modules/${name}`]?.integrity;
      const problems = npmLockProblems(lock);
      return problems.length ? { fail: problems.slice(0, 5).join('; ') } : { detail: `@ifc-lite/wasm@${resolved.wasm}, @ifc-lite/cli@${resolved.cli}; every lock entry resolves from ${NPM_REGISTRY}` };
    });
    const wasmDir = join(project, 'node_modules/@ifc-lite/wasm');
    const cliEntry = join(project, 'node_modules/@ifc-lite/cli/dist/index.js');
    const npmReady = installed.status === 'pass';
    const needInstall = () => (npmReady ? null : { skip: 'npm-install did not pass' });

    await step('npm-installed-versions', () => needInstall() ?? (() => {
      const got = ['wasm', 'cli'].map((n) => JSON.parse(readFileSync(join(project, `node_modules/@ifc-lite/${n}/package.json`), 'utf8')).version);
      return got[0] === resolved.wasm && got[1] === resolved.cli ? { detail: got.join(', ') } : { fail: `installed ${got.join(', ')}` };
    })());

    // ---- default engine ------------------------------------------------------------------
    await step('wasm-default-engine', () => {
      if (needInstall()) return needInstall();
      const r = run(process.execPath, [fileURLToPath(import.meta.url), PROBE_FLAG, wasmDir, fixture], { cwd: work, env });
      if (!r.ok) return { fail: tail(r) };
      const probe = JSON.parse(r.stdout.trim().split('\n').pop());
      if (probe.ready !== true || !(probe.jobs > 0) || !(probe.triangles > 0)) return { fail: `no geometry processed: ${r.stdout.trim()}` };
      return { detail: `engine ${probe.version} processed ${probe.jobs} jobs -> ${probe.meshes} meshes, ${probe.triangles} triangles`, evidence: probe };
    });

    await step('cli-default-export', () => {
      if (needInstall()) return needInstall();
      const version = run(process.execPath, [cliEntry, '--version'], { cwd: work, env });
      const obj = join(work, 'default.obj');
      const r = run(process.execPath, [cliEntry, 'export', fixture, '--format', 'obj', '--out', obj], { cwd: work, env });
      if (!r.ok) return { fail: tail(r) };
      const vertices = readFileSync(obj, 'utf8').split('\n').filter((l) => l.startsWith('v ')).length;
      return vertices > 0 ? { detail: `${version.stdout.trim()} wrote ${vertices} vertices` } : { fail: 'OBJ has no vertices' };
    });

    // ---- retained subpath and boundaries --------------------------------------------------
    await step('wasm-retained-subpath', () => {
      if (needInstall()) return needInstall();
      if (!existsSync(join(wasmDir, 'retained.d.ts')) || !existsSync(join(wasmDir, 'pkg-retained/ifc-lite.d.ts'))) return { fail: 'retained type declarations missing' };
      if (existsSync(join(wasmDir, 'pkg-retained/ifc-lite.js'))) return { fail: 'package unexpectedly ships a retained engine' };
      const r = run(process.execPath, [fileURLToPath(import.meta.url), RETAINED_PROBE_FLAG, project], { cwd: work, env });
      if (!r.ok) return { fail: tail(r) };
      const probe = JSON.parse(r.stdout.trim().split('\n').pop());
      if (!probe.hasLoader) return { fail: 'loadRetainedEngine export missing' };
      // The one expected refusal: the engine module is not installed. A TypeError or any other failure is a broken package.
      if (!retainedAbsent(probe)) return { fail: `loadRetainedEngine did not fail with the missing-engine error: ${probe.rejected ? `${probe.name} ${probe.code ?? ''} ${probe.message}` : 'it resolved'}` };
      return { detail: `resolves to ${relative(project, probe.entry)}; loadRetainedEngine fails with ${probe.code} for pkg-retained/ifc-lite.js (types only, no engine installed)` };
    });

    const tarballs = join(work, 'tarballs');
    mkdirSync(tarballs);
    const integrity = {};
    // Untrusted archives are extracted into their own new, empty directories; nothing is run from them.
    const extractArchive = (archive, name) => {
      const dir = join(work, name);
      mkdirSync(dir);
      const r = run('tar', ['-xzf', archive, '-C', dir, '--no-same-owner']);
      return r.ok ? { dir } : { error: `extract failed: ${tail(r, 200)}` };
    };
    const contentProblems = (dir, kind, strip) => {
      const bad = [];
      for (const file of walkFiles(dir)) {
        const problem = contentViolation(strip(relative(dir, file).split(sep).join('/')), readFileSync(file), kind);
        if (problem) bad.push(problem);
      }
      return bad;
    };
    const inspectNpm = (id, name, version, kind) => step(id, () => {
      const pack = run('npm', ['pack', `${name}@${version}`, '--json', '--pack-destination', tarballs], { cwd: work, env });
      if (!pack.ok) return { fail: tail(pack) };
      const meta = JSON.parse(pack.stdout)[0];
      const files = meta.files.map((f) => f.path);
      const notices = run('tar', ['-xOzf', join(tarballs, meta.filename), 'package/THIRD_PARTY_NOTICES.txt']);
      const extracted = extractArchive(join(tarballs, meta.filename), `${id}-files`);
      const problems = [...boundaryViolations(files, kind), ...(extracted.error ? [extracted.error] : contentProblems(extracted.dir, kind, stripArchiveRoot)),
        ...noticeProblems(notices.ok ? notices.stdout : undefined)];
      integrity[name] = meta.integrity;
      if (lockIntegrity[name] !== meta.integrity) problems.push(`lockfile integrity ${lockIntegrity[name]} differs from the npm pack tarball ${meta.integrity}`);
      return problems.length ? { fail: problems.slice(0, 6).join('; ') }
        : { detail: `${files.length} files, no SDK/native binaries (by name and by ELF/Mach-O/PE/wasm content), THIRD_PARTY_NOTICES.txt present with no OPEN:`, evidence: { shasum: meta.shasum, integrity: meta.integrity } };
    });
    await inspectNpm('wasm-archive-boundaries', '@ifc-lite/wasm', resolved.wasm, 'npm-wasm');
    await inspectNpm('cli-archive-boundaries', '@ifc-lite/cli', resolved.cli, 'npm-cli');

    // ---- provenance ----------------------------------------------------------------------
    const published = [['@ifc-lite/wasm', resolved.wasm], ['@ifc-lite/cli', resolved.cli]];
    let auditReport;
    await step('npm-signatures', () => {
      if (needInstall()) return needInstall();
      const r = run('npm', ['audit', 'signatures', '--json', '--include-attestations'], { cwd: project, env, timeout: 300_000 });
      let report;
      try { report = JSON.parse(r.stdout); } catch { return { fail: tail(r) }; }
      auditReport = report;
      const problems = auditProblems(report, published);
      if (!r.ok && !problems.length) problems.push(`npm audit signatures exited ${r.status}`);
      return problems.length ? { fail: problems.join('; ') }
        : { detail: `${report.verified.length} packages verified; ${published.map(([n, v]) => `${n}@${v}`).join(' and ')} verified with provenance attestations; 0 invalid, 0 missing` };
    });
    // The identity policy runs on the bundles npm verified above, never on a second fetch.
    for (const [name, version] of published) {
      await step(`provenance:${name}`, () => {
        if (!integrity[name]) return { fail: 'no downloaded tarball integrity to bind the attestation to' };
        const problems = provenanceProblems(verifiedAttestations(auditReport, name, version), { name, version, integrity: integrity[name] });
        return problems.length ? { fail: problems.join('; ') }
          : { detail: `${name}@${version}: the npm-verified SLSA provenance binds the downloaded tarball digest to ${EXPECTED_REPO} ${EXPECTED_WORKFLOW} (statement and signing-certificate identity)` };
      });
    }

    // ---- crates.io: archive and consumer builds -----------------------------------------
    let crateSha256;
    await step('crate-archive', async () => {
      const url = `${CRATES_STATIC}/${CRATE}/${CRATE}-${resolved.crate}.crate`;
      const response = await fetch(url);
      if (!response.ok) return { fail: `${url} -> HTTP ${response.status}` };
      const archive = join(tarballs, `${CRATE}-${resolved.crate}.crate`);
      const crateBytes = Buffer.from(await response.arrayBuffer());
      crateSha256 = createHash('sha256').update(crateBytes).digest('hex');
      writeFileSync(archive, crateBytes);
      const list = run('tar', ['-tzf', archive]);
      if (!list.ok) return { fail: tail(list) };
      const files = list.stdout.split('\n').filter(Boolean).map(stripArchiveRoot);
      const manifest = run('tar', ['-xOzf', archive, `${CRATE}-${resolved.crate}/Cargo.toml`]);
      const extracted = extractArchive(archive, 'crate-files');
      const problems = [...boundaryViolations(files, 'crate'), ...(extracted.error ? [extracted.error] : contentProblems(extracted.dir, 'crate', stripArchiveRoot)), ...(manifest.ok ? crateManifestProblems(manifest.stdout) : ['Cargo.toml unreadable'])];
      return problems.length ? { fail: problems.slice(0, 6).join('; ') } : { detail: `${files.length} files; source-only, no SDK/WASM/build script; registry geometry dependency and retained-runtime forwarding intact` };
    });

    const cargoProbe = run('cargo', ['-V'], { cwd: work, env });
    toolchain.cargo = cargoProbe.ok ? cargoProbe.stdout.trim() : undefined;
    const noCargo = cargoProbe.ok ? null : { skip: `cargo unusable outside the repo toolchain scope (pass --toolchain or set RUSTUP_TOOLCHAIN): ${tail(cargoProbe, 200)}` };
    const consumer = join(work, 'rust-consumer');
    const cargoSetup = await step('crate-consumer-setup', () => {
      if (noCargo) return noCargo;
      mkdirSync(consumer);
      const init = run('cargo', ['init', '--bin', '--name', 'smoke_consumer', '--vcs', 'none', consumer], { cwd: work, env });
      const add = init.ok && run('cargo', ['add', `${CRATE}@=${resolved.crate}`], { cwd: consumer, env });
      if (!init.ok || !add.ok) return { fail: tail(init.ok ? add : init) };
      writeFileSync(join(consumer, 'Cargo.toml'), `${readFileSync(join(consumer, 'Cargo.toml'), 'utf8')}\n[features]\nretained-runtime = ["${CRATE}/retained-runtime"]\n`);
      writeFileSync(join(consumer, 'src/main.rs'), `use ifc_lite_geometry_runtime::MeshLimits;
#[cfg(feature = "retained-runtime")]
use ifc_lite_geometry_runtime::RetainedBooleanIdentity;

fn main() {
    println!("MeshLimits={}", std::mem::size_of::<MeshLimits>());
    #[cfg(feature = "retained-runtime")]
    println!("RetainedBooleanIdentity={}", std::mem::size_of::<RetainedBooleanIdentity>());
}
`);
      return { detail: `consumer depends on ${CRATE} =${resolved.crate} from crates.io` };
    });
    const cargoStep = (id, args, expect) => step(id, () => {
      if (cargoSetup.status !== 'pass') return { skip: cargoSetup.status === 'skip' ? cargoSetup.detail : 'consumer setup did not pass' };
      const r = run('cargo', args, { cwd: consumer, env, timeout: 1_800_000 });
      if (!r.ok) return { fail: tail(r, 900) };
      const lock = cargoLockProblems(readFileSync(join(consumer, 'Cargo.lock'), 'utf8'), 'smoke_consumer');
      if (lock.length) return { fail: `non-registry source: ${lock.slice(0, 3).join('; ')}` };
      return r.stdout.includes(expect) ? { detail: `built and ran; ${r.stdout.trim().replace(/\n/g, ', ')}` } : { fail: `expected output ${expect}; got ${r.stdout.trim()}` };
    });
    await cargoStep('crate-default-features', ['run', '--quiet'], 'MeshLimits=');
    await cargoStep('crate-retained-runtime', ['run', '--quiet', '--features', 'retained-runtime'], 'RetainedBooleanIdentity=');

    await step('crate-checksum', () => {
      if (!crateSha256) return { fail: 'no downloaded .crate to compare' };
      if (cargoSetup.status !== 'pass') return { skip: 'consumer setup did not pass, so there is no Cargo.lock' };
      const locked = lockChecksum(readFileSync(join(consumer, 'Cargo.lock'), 'utf8'), CRATE, resolved.crate);
      return locked === crateSha256 ? { detail: `the fetched .crate sha256 ${crateSha256.slice(0, 16)}… equals the Cargo.lock checksum`, evidence: { sha256: crateSha256 } }
        : { fail: `fetched .crate sha256 ${crateSha256} differs from the Cargo.lock checksum ${locked}` };
    });

    // ---- Python wheel ----------------------------------------------------------------------
    await step('python-wheel', async () => {
      if (options.wheel === 'skip') return { skip: '--wheel skip' };
      // An explicitly requested wheel version that cannot be checked here is a failure, never a skip.
      const unavailable = (reason) => (options.wheel === 'latest' ? { skip: reason } : { fail: `requested wheel ${options.wheel} not checked: ${reason}` });
      if (process.platform !== 'linux') return unavailable(`wheel import check is linux-only (host ${process.platform})`);
      const response = await fetch(options.wheel === 'latest' ? 'https://pypi.org/pypi/ifclite-geom/json' : `https://pypi.org/pypi/ifclite-geom/${options.wheel}/json`);
      if (!response.ok) return { fail: `PyPI lookup HTTP ${response.status}` };
      const release = await response.json();
      resolved.wheel = release.info.version;
      const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const py = run('python3', [...WHEEL_PYTHON_FLAGS, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { cwd: work, env });
      if (!py.ok) return unavailable(`python3 unavailable: ${tail(py, 200)}`);
      const python = py.stdout.trim().split(' ').map(Number);
      const wanted = selectWheel(release.urls.filter((u) => u.packagetype === 'bdist_wheel').map((u) => u.filename), { python, arch });
      const file = release.urls.find((u) => u.filename === wanted);
      if (!file) return { fail: `no ifclite-geom ${release.info.version} manylinux ${arch} wheel matches local CPython ${python.join('.')} (cpXY/abi3)` };
      const wheel = await fetch(file.url);
      if (!wheel.ok) return { fail: `${file.url} -> HTTP ${wheel.status}` };
      const bytes = Buffer.from(await wheel.arrayBuffer());
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== file.digests.sha256) return { fail: `sha256 mismatch for ${file.filename}` };
      const target = join(work, 'py-site');
      mkdirSync(target);
      writeFileSync(join(work, file.filename), bytes);
      // Isolated interpreter (-I): the wheel is unpacked into an empty directory and added to sys.path explicitly.
      const unpack = run('python3', [...WHEEL_PYTHON_FLAGS, '-c', 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(work, file.filename), target], { cwd: work, env });
      if (!unpack.ok) return { fail: tail(unpack) };
      const probe = run('python3', wheelProbeArgv(fixture, target), { cwd: work, env });
      if (!probe.ok || !(Number(probe.stdout.trim()) > 0)) return { fail: tail(probe) };
      return { detail: `ifclite-geom ${release.info.version} (${file.filename}, sha256 verified; published binary wheel on its own release train) tessellated ${probe.stdout.trim()} elements. A wheel build from the release source is not covered.`, evidence: { sha256: digest } };
    });

    // ---- Retained export end to end -------------------------------------------------------
    await step('retained-export-e2e', () => {
      if (!retainedEngine) return { skip: 'not run: no engine directory (IFCLITE_SMOKE_RETAINED_ENGINE / --retained-engine)' };
      if (needInstall()) return needInstall();
      const obj = join(work, 'retained.obj');
      const report = join(work, 'retained-report.json');
      const r = run(process.execPath, [cliEntry, 'export', fixture, '--format', 'obj', '--kernel', 'retained',
        '--retained-engine', resolve(retainedEngine), '--retained-report', report, '--out', obj], { cwd: work, env });
      if (!r.ok) return { fail: tail(r) };
      const vertices = readFileSync(obj, 'utf8').split('\n').filter((l) => l.startsWith('v ')).length;
      const summary = JSON.parse(readFileSync(report, 'utf8'));
      if (!String(summary.format ?? '').startsWith('ifc-lite.retained-report/') || !(summary.summary?.published > 0) || !(vertices > 0)) {
        return { fail: `retained export produced no published products (published=${summary.summary?.published}, vertices=${vertices})` };
      }
      const bytes = readFileSync(join(resolve(retainedEngine), 'engine-manifest.json'));
      const identity = engineEvidence({ report: summary, manifest: JSON.parse(bytes.toString('utf8')), manifestFileSha256: createHash('sha256').update(bytes).digest('hex'),
        strict: options.strict, expected: { manifestSha256: options.expectEngineManifestSha256, sdkRevision: options.expectSdkRevision } });
      const published = `published ${summary.summary.published}/${summary.summary.candidates} products, ${vertices} vertices, report ${summary.format}`;
      const evidence = { engine: resolve(retainedEngine), ...identity.evidence };
      return identity.status === 'fail' ? { fail: `${published}; ${identity.problems.join('; ')}`, evidence } : { status: identity.status, detail: `${published}; ${identity.detail}`, evidence };
    });
  } finally {
    if (!options.keep) rmSync(work, { recursive: true, force: true });
  }
  return finish();

  function finish() {
    return {
    schema: 'ifc-lite.released-artifact-smoke/1',
    requested: { wasm: options.wasm, cli: options.cli, crate: options.crate, wheel: options.wheel },
    resolved, toolchain, strict: Boolean(options.strict), fixture: relative(REPO, fixture), retainedEngineSupplied: Boolean(retainedEngine),
    workDir: options.keep ? work : null, ...summarize(steps), steps,
    };
  }
}

if (isMainEntry(import.meta.url)) {
  if (process.argv[2] === PROBE_FLAG) {
    await wasmProbe(process.argv[3], process.argv[4]);
  } else if (process.argv[2] === RETAINED_PROBE_FLAG) {
    await retainedProbe(process.argv[3]);
  } else {
    let options;
    try { options = parseArgs(process.argv.slice(2)); } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    const summary = await smoke(options);
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (options.out) writeFileSync(options.out, json);
    process.stdout.write(json);
    process.exit(summary.counts.fail ? 1 : 0);
  }
}
