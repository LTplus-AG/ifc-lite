/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* #8042 packed public facade acceptance. Run only inside parent fleet admission.
 * No builds, dependency installs, registry access, source edits, or skipped cases.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const help = `Usage: node scripts/diff-packed-node22.mjs --node22 /absolute/node
  --out /absolute/new-evidence-directory --prep-receipt /absolute/build-receipt
  [--source /absolute/prepared-checkout] [--pnpm /absolute/pnpm]
  [--package /absolute/additional-package-directory]...
Requires clean committed source, prepared diff dist and BOTH wasm runtimes,
root pinned pnpm and installed tsx. No automatic downloads or build fallback.`;
const options = { source: process.cwd(), pnpm: 'pnpm', packages: [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (key === '--help') { console.log(help); process.exit(0); }
  assert.ok(value, `Missing value for ${key}\n${help}`);
  if (key === '--package') options.packages.push(realpathSync(value));
  else {
    assert.ok(['--source', '--pnpm', '--node22', '--out', '--prep-receipt'].includes(key), `Unknown ${key}`);
    options[key.slice(2)] = value;
  }
}
for (const key of ['node22', 'out', 'prep-receipt']) assert.ok(isAbsolute(options[key] ?? ''), `--${key} must be absolute\n${help}`);
const source = realpathSync(options.source);
const out = resolve(options.out);
assert.ok(!existsSync(out), 'Use a NEW evidence directory; inspect original outcome before retrying');
const inside = (parent, child) => child === parent || (!relative(parent, child).startsWith('..') && !isAbsolute(relative(parent, child)));
assert.ok(!inside(source, out), 'Evidence must be outside source');
mkdirSync(out, { recursive: true });
const env = { ...process.env };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete env[name];
env.npm_config_ignore_scripts = 'true';
env.COREPACK_ENABLE_NETWORK = '0';
env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const report = { status: 'preparing', source, stages: [], packages: [] };
const deadline = Date.now() + 300_000;
let scratch;
function save() { writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2)); }
function run(label, command, args, cwd = source, timeout = 30_000) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'Five-minute acceptance deadline exceeded');
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8',
    timeout: Math.min(timeout, remaining),
    killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(join(out, `${label}.stdout.log`), result.stdout ?? '');
  writeFileSync(join(out, `${label}.stderr.log`), result.stderr ?? '');
  report.stages.push({ label, command, args, cwd, status: result.status, signal: result.signal,
    error: result.error && { message: result.error.message, stack: result.error.stack } });
  save();
  assert.ok(!result.error && result.status === 0, `${label} failed: ${result.error?.message ?? result.stderr}; see ${out}`);
  return result.stdout.trim();
}
function inventory(root) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), `Unexpected package symlink: ${path}`);
      if (stat.isDirectory()) walk(path);
      else {
        assert.ok(stat.isFile() && stat.size <= 64 * 1024 * 1024, `Oversized/nonregular packed file: ${path}`);
        files.push({ path: relative(root, path), bytes: stat.size, sha256: digest(readFileSync(path)) });
      }
    }
  }
  walk(root);
  assert.ok(files.length <= 2000 && files.reduce((sum, f) => sum + f.bytes, 0) <= 128 * 1024 * 1024, 'Package exceeds acceptance budget');
  return files;
}
try {
  report.sourceCommit = run('commit', 'git', ['rev-parse', 'HEAD']);
  assert.equal(run('clean', 'git', ['status', '--porcelain', '--untracked-files=normal']), '', 'Prepared source must be clean');
  report.prepReceipt = { path: realpathSync(options['prep-receipt']), sha256: digest(readFileSync(options['prep-receipt'])) };
  cpSync(options['prep-receipt'], join(out, 'prep-receipt'));
  const version = run('node-version', options.node22, ['--version']);
  assert.match(version, /^v22\.13\./, 'Wrong Node version; no fallback permitted');
  report.node = { version, path: realpathSync(options.node22), sha256: digest(readFileSync(options.node22)) };
  const manager = json(join(source, 'package.json')).packageManager;
  assert.equal(`pnpm@${run('pnpm-version', options.pnpm, ['--version'])}`, manager, 'Use repository-pinned pnpm');
  // The explicit TS loader is used ONLY for the separate oracle process.
  const tsx = realpathSync(fileURLToPath(import.meta.resolve('tsx/esm/api')));
  report.oracleLoader = { path: tsx, sha256: digest(readFileSync(tsx)) };
  const nodeArgs = ['--no-experimental-strip-types', '--max-old-space-size=512'];
  const support = dirname(fileURLToPath(import.meta.url));
  report.harness = ['diff-packed-node22.mjs', 'packed-diff/consumer.mjs', 'packed-diff/oracle.mjs', 'packed-diff/semantics.mjs']
    .map(path => ({ path, sha256: digest(readFileSync(join(support, path))) }));
  run('frozen-oracle', options.node22, [...nodeArgs, join(support, 'packed-diff/oracle.mjs'), tsx,
    join(source, 'packages/diff/test/oracle/index.ts')]);

  scratch = mkdtempSync(join(tmpdir(), 'ifc-packed-8042-'));
  assert.ok(!inside(source, scratch), 'Consumer must be outside workspace');
  // Ancestor dependency trees must not supply undeclared consumer dependencies.
  for (let parent = dirname(scratch); ; parent = dirname(parent)) {
    assert.ok(!existsSync(join(parent, 'node_modules')), `Ancestor dependency resolution is not empty: ${parent}`);
    if (parent === dirname(parent)) break;
  }
  report.consumer = scratch;
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const dirs = [join(source, 'packages/diff'), join(source, 'packages/wasm'), ...options.packages];
  assert.ok(dirs.length <= 8, 'At most eight explicitly supplied packages');
  const known = new Map(dirs.map(dir => [json(join(dir, 'package.json')).name, dir]));
  assert.equal(known.size, dirs.length, 'Duplicate package');
  mkdirSync(join(out, 'packs'));
  for (const [name, dir] of known) {
    assert.match(name, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/);
    const label = `pack-${name.replaceAll(/[@/]/g, '-')}`;
    const destination = join(out, 'packs', label);
    mkdirSync(destination);
    run(label, options.pnpm, ['--dir', dir, 'pack', '--pack-destination', destination], source, 60_000);
    const archives = readdirSync(destination).filter(f => f.endsWith('.tgz'));
    assert.equal(archives.length, 1, 'Expected exactly one real pnpm pack tarball');
    const archive = join(destination, archives[0]);
    assert.ok(lstatSync(archive).size <= 64 * 1024 * 1024);
    // Validate tar paths and types BEFORE extraction. No install/link protocol.
    const listing = run(`${label}-paths`, 'tar', ['-tzf', archive]);
    for (const path of listing.split('\n')) {
      assert.ok(path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\'), `Unsafe tar path: ${path}`);
    }
    const verbose = run(`${label}-types`, 'tar', ['-tvzf', archive]);
    assert.ok(verbose.split('\n').every(line => ['-', 'd'].includes(line[0])), 'Packed symlinks/devices are forbidden');
    const target = join(scratch, 'node_modules', name);
    mkdirSync(target, { recursive: true });
    run(`${label}-extract`, 'tar', ['-xzf', archive, '--strip-components=1', '-C', target]);
    const manifest = json(join(target, 'package.json'));
    assert.equal(manifest.name, name);
    const files = inventory(target);
    // Packed runtime must be byte-identical to the prepared source artifacts.
    for (const file of files.filter(f => /\.(?:js|wasm|mjs|cjs)$/.test(f.path))) {
      const original = join(dir, file.path);
      assert.equal(digest(readFileSync(original)), file.sha256, `Pack changed runtime bytes: ${original}`);
    }
    report.packages.push({ name, version: manifest.version, archive, sha256: digest(readFileSync(archive)), files, manifest });
    save();
  }
  for (const pkg of report.packages) {
    const { dependencies = {}, optionalDependencies = {}, peerDependencies = {} } = pkg.manifest;
    for (const [name, range] of Object.entries({ ...dependencies, ...optionalDependencies, ...peerDependencies })) {
      const supplied = report.packages.find(p => p.name === name);
      assert.ok(supplied, `Missing real packed dependency ${name}; supply --package DIR (no registry fallback)`);
      assert.ok(range === supplied.version || range === '*', `Unreviewed dependency range ${name}@${range}; expected exact ${supplied.version}`);
    }
  }
  for (const path of [
    '@ifc-lite/diff/dist/index.js', '@ifc-lite/diff/dist/wasm-runtime.js',
    '@ifc-lite/wasm/pkg/ifc-lite.js', '@ifc-lite/wasm/pkg/ifc-lite_bg.wasm',
    '@ifc-lite/wasm/pkg-diff/ifc-lite-diff.js', '@ifc-lite/wasm/pkg-diff/ifc-lite-diff_bg.wasm',
  ]) assert.ok(lstatSync(join(scratch, 'node_modules', path)).size > 0, `Missing packed runtime ${path}`);
  for (const name of ['consumer.mjs', 'semantics.mjs']) cpSync(join(support, 'packed-diff', name), join(scratch, name));
  for (const mode of ['async', 'sync', 'retry']) {
    run(`consumer-${mode}`, options.node22, [...nodeArgs, 'consumer.mjs', mode], scratch, 20_000);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  if (scratch) {
    for (const name of readdirSync(scratch).filter(name => name.endsWith('.json') && name !== 'package.json')) {
      cpSync(join(scratch, name), join(out, name));
    }
    rmSync(scratch, { recursive: true, force: true });
    report.consumerReleased = true;
  }
  save();
}
console.log(JSON.stringify({ status: report.status, evidence: out }));
