/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { sourceSnapshot, verifySource } from './sdk-prepare.mjs';
import { execute, compilerEnvironment } from './native-hosted-process.mjs';
import { revisions, inputs, methodPaths, cargoArgs, limits, validateRefs, schedule, probeResult, freshnessLog } from './native-hosted-plan.mjs';
import { available } from './sdk-resources.mjs';
import { nativeFileIdentity, sameNativeFile } from './native-file-identity.mjs';
import { resolveCanonicalCargoShim, verifyCanonicalCargoResolution } from './native-cargo-resolution.mjs';
import { pythonTools, preparePrebuiltReceipt } from './native-prebuilt.mjs';
export const root = resolve(import.meta.dirname, '../..'), output = join(root, 'native-results');
const command = (program, args, directory = root) => execFileSync(program, args, { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 ** 2 }).trim();
export async function verify(provenance) {
  for (const source of provenance.sources) await verifySource(source);
  for (const [path, hash] of Object.entries(provenance.files)) if (await fileHash(path) !== hash) throw new Error(`native frozen file changed: ${path}`);
  for (const name of ['rustup', 'cargo', 'rustc']) {
    if (!sameNativeFile(nativeFileIdentity(provenance.tools[name]), provenance.tools[`${name}FileIdentity`])
      || provenance.files[provenance.tools[name]] !== provenance.tools[`${name}Sha256`]
      || statSync(provenance.tools[name]).size !== provenance.tools[`${name}FileBytes`]) {
      throw new Error(`native frozen ${name} file identity/hash binding changed`);
    }
  }
  for (const resolution of Object.values(provenance.cargoShimResolutions)) await verifyCanonicalCargoResolution(resolution);
}
async function libraries(path, files, consumed) {
  const observation = spawnSync('ldd', [path], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 });
  if (observation.error) throw observation.error;
  const raw = `${observation.stdout}${observation.stderr}`.trim();
  if (/not found/.test(raw) || (observation.status !== 0 && !(observation.status === 1 && /^(?:statically linked|not a dynamic executable)$/.test(raw)))) throw new Error('native tool libraries refused');
  for (const match of raw.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s/gm)) {
    const library = realpathSync(match[1]); files[library] = await fileHash(library);
    if (consumed) consumed[library] = files[library];
  }
  return raw;
}
export function repositoryNightlyChannel() {
  const channels = [...readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').matchAll(/^channel\s*=\s*"(nightly-\d{4}-\d{2}-\d{2})"\s*$/gm)];
  if (channels.length !== 1) throw new Error('native repository nightly selector refused');
  return channels[0][1];
}
async function toolFreeze(directories) {
  const channel = repositoryNightlyChannel();
  const bash = realpathSync(command('which', ['bash'])), selectionRustup = realpathSync(command('which', ['rustup']));
  const rustTool = name => realpathSync(command(selectionRustup, ['which', '--toolchain', channel, name]));
  const tools = { node: realpathSync(process.execPath), bash, selectionRustup, python: realpathSync(command('which', ['python3'])),
    cargo: rustTool('cargo'), rustc: rustTool('rustc'), rustdoc: rustTool('rustdoc'),
    cc: realpathSync(command('which', ['cc'])) };
  tools.toolchain = basename(dirname(dirname(tools.rustc)));
  if (!tools.toolchain.startsWith(`${channel}-`)) throw new Error('native installed selector differs from repository pin');
  const environment = compilerEnvironment({ ...process.env, OBS: '0', CARGO_BUILD_JOBS: '1', CARGO_TERM_COLOR: 'never' }, tools);
  const cargoShimResolutions = {};
  for (const [arm, directory] of Object.entries(directories)) cargoShimResolutions[arm] = await resolveCanonicalCargoShim({ bash, directory, environment });
  const selectedProxy = cargoShimResolutions.base.after.cargo;
  if (selectedProxy.realPath !== cargoShimResolutions.candidate.after.cargo.realPath
    || selectedProxy.sha256 !== cargoShimResolutions.candidate.after.cargo.sha256) throw new Error('canonical Cargo proxy differs between source arms');
  tools.rustup = selectedProxy.realPath;
  const files = {}, linkedLibraries = {}, nativeRuntimeFiles = {};
  for (const [name, path] of Object.entries(tools).filter(([name]) => name !== 'toolchain')) {
    files[path] = await fileHash(path);
    linkedLibraries[name] = await libraries(path, files, ['bash', 'python'].includes(name) ? nativeRuntimeFiles : undefined);
    if (['bash', 'python'].includes(name)) nativeRuntimeFiles[path] = files[path];
  }
  const nativePython = pythonTools(root, tools);
  Object.assign(files, nativePython.files); Object.assign(nativeRuntimeFiles, nativePython.files);
  for (const path of Object.keys(nativePython.files).filter(path => path.endsWith('.so'))) {
    linkedLibraries[`python-extension:${path}`] = await libraries(path, files, nativeRuntimeFiles);
  }
  for (const receipt of Object.values(cargoShimResolutions)) Object.assign(files, receipt.files);
  for (const name of ['rustup', 'cargo', 'rustc']) {
    tools[`${name}FileIdentity`] = nativeFileIdentity(tools[name]);
    tools[`${name}Sha256`] = files[tools[name]];
    tools[`${name}FileBytes`] = statSync(tools[name]).size;
  }
  const sysroot = realpathSync(command(tools.rustc, ['--print', 'sysroot'])); let count = 0;
  const walk = async (directory, depth = 0) => {
    if (depth > 32) throw new Error('native sysroot depth bound');
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error('native sysroot symlink refused');
      if (item.isDirectory()) await walk(path, depth + 1);
      else if (item.isFile()) { if (++count > 100000) throw new Error('native sysroot count bound'); files[path] = await fileHash(path); }
    }
  };
  await walk(join(sysroot, 'lib'));
  return { tools, files, linkedLibraries, sysroot, cargoShimResolutions, nativePython, nativeRuntimeFiles,
    rust: command(tools.rustc, ['--version']), cargoVersion: command(tools.cargo, ['--version']) };
}
async function main() {
  mkdirSync(output, { recursive: true }); const write = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2));
  validateRefs(process.env.BASE_REF, process.env.CANDIDATE_REF);
  if (process.argv[2] === 'validate') { write('protocol.json', { revisions, schedule: schedule(), limits, scope: 'PROSPECTIVE_NATIVE_PHASE_ATTRIBUTION' }); return; }
  if (process.argv[2] !== 'build') throw new Error('native preparation mode required');
  let refusal; const report = { status: 'pending', builds: {}, fixtureCommands: [] };
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { refusal ??= `received ${signal}`; }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    if (available() < limits.initialBytes || process.env.CARGO_TARGET_DIR || !['', '0'].includes(process.env.OBS ?? '')
      || ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER'].some(key => process.env[key])) throw new Error('native initial resource/default target refused');
    const directories = { base: resolve(process.env.BASE_DIR), candidate: resolve(process.env.CANDIDATE_DIR) };
    for (const [index, option] of [[], ['--check']].entries()) {
      if (refusal) throw new Error(refusal);
      const row = await execute([process.execPath, 'scripts/fixtures/fetch-fixtures.mjs', ...option, ...inputs.map(item => item.path)],
        root, join(output, `fixtures-${index}`), { wallMs: 5 * 60000 });
      report.fixtureCommands.push(row); write(`fixtures-${index}.json`, row);
      if (row.status !== 'complete') throw new Error(row.reason);
    }
    const manifest = JSON.parse(readFileSync(join(root, 'tests/models/manifest.json'), 'utf8'));
    report.fixtures = inputs.map(item => {
      const entry = manifest.files.find(row => row.path === item.path);
      if (!entry || entry.sha256 !== item.sha256 || entry.size !== item.bytes) throw new Error('native fixed manifest mismatch');
      return { ...item, file: join(root, 'tests/models', item.path) };
    });
    report.sources = [await sourceSnapshot(root, command('git', ['rev-parse', 'HEAD']))];
    const compiler = await toolFreeze(directories); Object.assign(report, compiler, { directories, revisions });
    for (const [index, row] of report.fixtureCommands.entries()) {
      report.files[join(output, `fixtures-${index}.json`)] = await fileHash(join(output, `fixtures-${index}.json`));
      for (const [stream, path] of Object.values(row.paths).entries()) report.files[path] = row.hashes[stream];
    }
    for (const fixture of report.fixtures) {
      if (statSync(fixture.file).size !== fixture.bytes || await fileHash(fixture.file) !== fixture.sha256) throw new Error('native fixture bytes differ');
      report.files[fixture.file] = fixture.sha256;
    }
    for (const arm of ['base', 'candidate']) {
      const directory = directories[arm];
      if (existsSync(join(directory, 'target'))) throw new Error('native target must be fresh');
      report.sources.push(await sourceSnapshot(directory, revisions[arm]));
      for (const path of [...methodPaths.filter(path => path !== 'scripts/perf/probe.sh'), 'rust-toolchain.toml']) {
        if (await fileHash(join(root, path)) !== await fileHash(join(directory, path))) throw new Error('canonical method/toolchain differs');
      }
    }
    report.runtimeProtocol = 'native-fd-prebuilt-v1';
    report.probeCompatibility = { scope: 'ONLY probe.sh differs: explicit controller verified-prebuilt mode; original arm default command separately qualified outside cohort',
      controllerSha256: await fileHash(join(root, 'scripts/perf/probe.sh')),
      arms: Object.fromEntries(await Promise.all(Object.entries(directories).map(async ([arm, directory]) => [arm, await fileHash(join(directory, 'scripts/perf/probe.sh'))]))) };
    if (report.probeCompatibility.arms.base !== report.probeCompatibility.arms.candidate) throw new Error('original arm probe scripts differ');
    report.closureLimitations = 'Tracked Git source, actual Node/Bash/Python/Rust/Cargo/cc executables, consumed Python modules/policy, observed ldd libraries, Rust sysroot lib tree and locked Cargo build receipts. Cargo registry/build-script/linker closure, transient same-inode writes, dynamically selected loader inputs and whole machine/environment are not fully frozen.';
    report.frozenUTC = new Date().toISOString(); await verify(report); write('build-start.json', report);
    for (const arm of ['base', 'candidate']) {
      if (refusal) throw new Error(refusal);
      const directory = directories[arm];
      const row = await execute(['cargo', ...cargoArgs, '--locked'], directory, join(output, `${arm}-build`), { tools: report.tools, wallMs: 30 * 60000 });
      report.builds[arm] = row; write(`${arm}-build.json`, row);
      if (row.status !== 'complete') throw new Error(row.reason);
      if (!/^\s*Compiling ifc-lite-processing v/m.test(readFileSync(row.paths.stderr, 'utf8'))) throw new Error('fresh native processing compilation evidence missing');
      const binary = join(directory, 'target/profiling/examples/perf_probe');
      if (statSync(binary).mtimeMs < Date.parse(report.frozenUTC)) throw new Error('native binary freshness refused');
      row.linkedLibraries = await libraries(binary, report.files, report.nativeRuntimeFiles);
      row.binary = binary; row.binarySha256 = await fileHash(binary); report.files[binary] = row.binarySha256;
      write(`${arm}-build.json`, row); report.files[join(output, `${arm}-build.json`)] = await fileHash(join(output, `${arm}-build.json`));
      for (const [index, path] of Object.values(row.paths).entries()) report.files[path] = row.hashes[index];
      await verify(report);
    }
    report.canonicalQualifications = {};
    for (const arm of ['base', 'candidate']) {
      if (refusal) throw new Error(refusal);
      // Literal subject script, unmodified and NOT claimed --locked. Outside
      // the cohort it demonstrates original-command/output compatibility.
      const fixture = report.fixtures[0];
      const row = await execute(['bash', 'scripts/perf/probe.sh', fixture.file, '--iters', '5', '--json', '--fingerprint'],
        directories[arm], join(output, `${arm}-original-probe-qualification`), { tools: report.tools });
      report.canonicalQualifications[arm] = row;
      write(`${arm}-original-probe-qualification.json`, row);
      if (row.status !== 'complete') throw new Error(row.reason);
      freshnessLog(readFileSync(row.paths.stderr, 'utf8'));
      row.result = probeResult(readFileSync(row.paths.stdout, 'utf8'), fixture.file);
      row.scope = 'original literal arm command outside cohort; no --locked flag; not an accepted paired timing';
      write(`${arm}-original-probe-qualification.json`, row);
      for (const [index, path] of Object.values(row.paths).entries()) report.files[path] = row.hashes[index];
      report.files[join(output, `${arm}-original-probe-qualification.json`)] = await fileHash(join(output, `${arm}-original-probe-qualification.json`));
      await verify(report);
    }
    report.prebuiltReceipts = {};
    for (const arm of ['base', 'candidate']) report.prebuiltReceipts[arm] = await preparePrebuiltReceipt(root, output, report, arm);
    if (refusal) throw new Error(refusal); report.status = 'qualified-native-builds-not-timing';
  } catch (error) {
    report.status = 'refused'; report.reason = String(error); process.exitCode = 1;
    if (error.resolutionReceipt) report.cargoShimResolutionRefusal = error.resolutionReceipt;
  }
  finally {
    if (report.sources && report.files) { try { await verify(report); report.finalFrozenVerification = 'complete'; } catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; } }
    if (refusal) { report.status = 'refused'; report.reason = refusal; process.exitCode = 1; }
    for (const [signal, handler] of handlers) process.off(signal, handler); write('provenance.json', report); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
