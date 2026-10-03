/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { sourceSnapshot, verifySource } from './sdk-prepare.mjs';
import { execute } from './native-hosted-process.mjs';
import { revisions, inputs, methodPaths, cargoArgs, limits, validateRefs, schedule } from './native-hosted-plan.mjs';
import { available } from './sdk-resources.mjs';
export const root = resolve(import.meta.dirname, '../..'), output = join(root, 'native-results');
const command = (program, args, directory = root) => execFileSync(program, args, { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 ** 2 }).trim();
export async function verify(provenance) {
  for (const source of provenance.sources) await verifySource(source);
  for (const [path, hash] of Object.entries(provenance.files)) if (await fileHash(path) !== hash) throw new Error(`native frozen file changed: ${path}`);
}
async function libraries(path, files) {
  const observation = spawnSync('ldd', [path], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 });
  if (observation.error) throw observation.error;
  const raw = `${observation.stdout}${observation.stderr}`.trim();
  if (/not found/.test(raw) || (observation.status !== 0 && !(observation.status === 1 && /^(?:statically linked|not a dynamic executable)$/.test(raw)))) throw new Error('native tool libraries refused');
  for (const match of raw.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s/gm)) { const library = realpathSync(match[1]); files[library] = await fileHash(library); }
  return raw;
}
export function repositoryNightlyChannel() {
  const channels = [...readFileSync(join(root, 'rust-toolchain.toml'), 'utf8').matchAll(/^channel\s*=\s*"(nightly-\d{4}-\d{2}-\d{2})"\s*$/gm)];
  if (channels.length !== 1) throw new Error('native repository nightly selector refused');
  return channels[0][1];
}
async function toolFreeze() {
  const channel = repositoryNightlyChannel();
  const rustTool = name => realpathSync(command('rustup', ['which', '--toolchain', channel, name]));
  const tools = { node: realpathSync(process.execPath), bash: realpathSync(command('which', ['bash'])),
    rustup: realpathSync(command('which', ['rustup'])), cargo: rustTool('cargo'),
    rustc: rustTool('rustc'), rustdoc: rustTool('rustdoc'), cc: realpathSync(command('which', ['cc'])) };
  const files = {}, linkedLibraries = {};
  for (const [name, path] of Object.entries(tools)) {
    files[path] = await fileHash(path);
    linkedLibraries[name] = await libraries(path, files);
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
  const cargoEnvironment = join(process.env.HOME, '.cargo/env');
  if (existsSync(cargoEnvironment)) files[cargoEnvironment] = await fileHash(cargoEnvironment);
  tools.toolchain = basename(dirname(dirname(tools.rustc)));
  if (!tools.toolchain.startsWith(`${channel}-`)) throw new Error('native installed selector differs from repository pin');
  return { tools, files, linkedLibraries, sysroot, rust: command(tools.rustc, ['--version']), cargoVersion: command(tools.cargo, ['--version']) };
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
    const compiler = await toolFreeze(); Object.assign(report, compiler, { directories, revisions });
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
      for (const path of [...methodPaths, 'rust-toolchain.toml']) if (await fileHash(join(root, path)) !== await fileHash(join(directory, path))) throw new Error('canonical method/toolchain differs');
    }
    report.closureLimitations = 'Tracked Git source, actual Node/Bash/Rust/Cargo/cc executables, observed ldd libraries, conservative Rust sysroot lib tree and locked Cargo build receipts. Cargo registry sources, build-script consumed external tools, linker subprocess closure and machine/environment are not fully frozen.';
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
      row.linkedLibraries = await libraries(binary, report.files);
      row.binary = binary; row.binarySha256 = await fileHash(binary); report.files[binary] = row.binarySha256;
      write(`${arm}-build.json`, row); report.files[join(output, `${arm}-build.json`)] = await fileHash(join(output, `${arm}-build.json`));
      for (const [index, path] of Object.values(row.paths).entries()) report.files[path] = row.hashes[index];
      await verify(report);
    }
    if (refusal) throw new Error(refusal); report.status = 'qualified-native-builds-not-timing';
  } catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
  finally {
    if (report.sources && report.files) { try { await verify(report); report.finalFrozenVerification = 'complete'; } catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; } }
    if (refusal) { report.status = 'refused'; report.reason = refusal; process.exitCode = 1; }
    for (const [signal, handler] of handlers) process.off(signal, handler); write('provenance.json', report); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
