/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Small synthetic Git/fleet/artifact metadata fixture. Never runtime evidence.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFixture } from './exact-route-fixture.mjs';
import { gitSource, sha256 } from '../exact-route-source.mjs';
import { compilerEvidence } from '../exact-route-compiler.mjs';
import { compareReceipts } from '../exact-route-receipts.mjs';
import { digest } from '../exact-route-inputs.mjs';
import { unitFixture, writeCompilerSources } from './exact-route-unit-fixture.mjs';
import { OPTIONS } from '../exact-route-schema.mjs';
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
export function cohort(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'exact-route-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'git'); mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  for (const path of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'pnpm-lock.yaml', 'package.json']) writeFileSync(join(repo, path), `fixture ${path}`);
  writeCompilerSources(repo);
  if (options.featureGraph) {
    const path = join(repo, 'rust/processing/Cargo.toml');
    writeFileSync(path, readFileSync(path, 'utf8') + '[features]\ndefault = []\n');
  }
  git(['add', '.']);
  const commit = message => { git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  const base = commit('original source');
  const overlay = 'rust/processing/examples/exact_route_capture.rs'; mkdirSync(join(repo, 'rust/processing/examples'), { recursive: true }); writeFileSync(join(repo, overlay), 'exact overlay fixture\n');
  git(['add', '.']); const execution = commit('overlay only');
  const manifest = { protocol: 'exact-route-v2', preCommonProgramBase: base, immediateIntegrationParent: base,
    overlay: [overlay], harness: { [overlay]: sha256(readFileSync(join(repo, overlay))) }, harnessSha256: sha256(JSON.stringify({ [overlay]: sha256(readFileSync(join(repo, overlay))) })),
    options: OPTIONS, fixtures: [{ path: 'real.ifc', sha256: 'a'.repeat(64) }] };
  const manifestPath = join(root, 'manifest.json'); json(manifestPath, manifest);
  const sources = [gitSource(repo, base, execution, manifest)];
  let branch = base;
  if (options.workspaceGraph) {
    git(['checkout', '-q', base]);
    for (const name of ['imported-geometry', 'geometry-runtime']) {
      const dir = join(repo, 'rust', name); mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "ifc-lite-${name}"\nversion = "1.0.0"\n` +
        (name === 'geometry-runtime' ? '[dependencies]\nifc-lite-geometry = { path = "../geometry" }\n' : ''));
      writeFileSync(join(dir, 'src/lib.rs'), `// ${name} protocol fixture\n`);
    }
    for (const [pkg, dep] of [['geometry', 'imported-geometry'], ['processing', 'geometry-runtime']]) {
      const path = join(repo, 'rust', pkg, 'Cargo.toml');
      writeFileSync(path, readFileSync(path, 'utf8') + `[dependencies]\nifc-lite-${dep} = { path = "../${dep}" }\n`);
    }
    if (options.featureGraph) {
      const path = join(repo, 'rust/processing/Cargo.toml');
      writeFileSync(path, readFileSync(path, 'utf8').replace('default = []', 'default = []\ntriangulation-alt = []'));
    }
    if (options.externalGraph) {
      const path = join(repo, 'rust/processing/Cargo.toml');
      writeFileSync(path, readFileSync(path, 'utf8') + 'external-added = "1.0.0"\n');
    }
    writeFileSync(join(repo, 'Cargo.lock'), 'fixture workspace additions locked' + (options.externalGraph ? '\nexternal-added 1.0.0' : ''));
    writeFileSync(join(repo, 'Cargo.toml'), 'fixture root members: core geometry processing imported-geometry geometry-runtime');
    git(['add', '.']); branch = commit('intended workspace graph fixture');
    mkdirSync(join(repo, 'rust/processing/examples'), { recursive: true }); writeFileSync(join(repo, overlay), 'exact overlay fixture\n');
    git(['add', '.']); const branchExecution = commit('same exact overlay');
    sources.push(gitSource(repo, branch, branchExecution, manifest));
  } else sources.push(sources[0]);
  const dirs = [join(root, 'base'), join(root, 'branch')];
  const fleetReceipts = dirs.map(d => `${d}-fleet.json`);
  const fleetLogs = dirs.map(d => `${d}-fleet.log`);
  const writeReceipt = (i, receipt) => {
    json(join(dirs[i], 'receipt.json'), receipt);
    const path = fleetReceipts[i];
    if (readFileSyncSafe(path)) {
      const fleet = JSON.parse(readFileSync(path));
      writeFileSync(fleetLogs[i], `EXACT_ROUTE_RECEIPT_SHA256 ${sha256(readFileSync(join(dirs[i], 'receipt.json')))}\n`);
      fleet.outputSha256 = sha256(readFileSync(fleetLogs[i])); json(path, fleet);
    }
  };
  dirs.forEach((dir, i) => {
    mkdirSync(dir); json(join(dir, '0.json'), captureFixture());
    const source = sources[i];
    git(['checkout', '-q', source.executionCommit]);
    const { events, artifacts, files, context } = unitFixture(repo, dir, source);
    const binary = artifacts.at(-1).executable; writeFileSync(join(dir, 'capture-binary'), readFileSync(binary));
    writeFileSync(join(dir, 'compiler-invocations.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'cargo-artifacts.jsonl'), artifacts.map(e => JSON.stringify(e)).join('\n'));
    json(join(dir, 'compiler-context.json'), context); json(join(dir, 'compiler-artifact-hashes.json'), files);
    writeFileSync(join(dir, 'cargo-stderr.log'), 'fixture verbose arguments');
    const receipt = { protocol: 'exact-route-v2', status: 'captured-uncompared', ...source, cwd: repo,
      requestedCommand: ['node', '/fixture/runner.mjs', 'run', repo, base, dir],
      commands: [[join(dir, 'capture-binary'), '/fixture/real.ifc', join(dir, '0.json')]],
      binary: { path: binary, artifact: 'capture-binary', executedPath: join(dir, 'capture-binary'), sha256: sha256(readFileSync(join(dir, 'capture-binary'))) },
      harness: manifest.harness, harnessSha256: manifest.harnessSha256, options: manifest.options,
      toolchain: 'fixture rustc', cargo: 'fixture cargo', runtime: { platform: 'fixture', arch: 'fixture', availableParallelism: 1 },
      manifestSha256: sha256(readFileSync(manifestPath)), compilerContextSha256: digest(context), environment: {}, compiler: { ...compilerEvidence(events, artifacts, context, files),
        invocationSha256: sha256(readFileSync(join(dir, 'compiler-invocations.jsonl'))), artifactEventsSha256: sha256(readFileSync(join(dir, 'cargo-artifacts.jsonl'))),
        verboseLogSha256: sha256(readFileSync(join(dir, 'cargo-stderr.log'))) },
      fixtures: [{ ...manifest.fixtures[0], execution: { executable: join(dir, 'capture-binary'), beforeSha256: files[binary], afterSha256: files[binary] }, capture: '0.json', captureSha256: sha256(readFileSync(join(dir, '0.json'))) }] };
    json(join(dir, 'receipt.json'), receipt);
    const snapshot = { commit: source.executionCommit, tree: source.executionTree, clean: true, worktreeDigest: sha256(''), toolchainInputs: source.toolchainInputs };
    writeFileSync(fleetLogs[i], `EXACT_ROUTE_RECEIPT_SHA256 ${sha256(readFileSync(join(dir, 'receipt.json')))}\n`);
    json(fleetReceipts[i], { outputSha256: sha256(readFileSync(fleetLogs[i])), id: `fixture-${i}`, cwd: repo, state: 'completed', exitCode: 0, sourceBefore: snapshot,
      sourceAfter: structuredClone(snapshot), sourceUnchanged: true, command: receipt.requestedCommand,
      tools: { rustc: { exitCode: 0, version: 'fixture rustc' }, cargo: { exitCode: 0, version: 'fixture cargo' } },
      artifacts: { [join(dir, 'receipt.json')]: sha256(readFileSync(join(dir, 'receipt.json'))) } });
  });
  return { dirs, manifest, base, branch, execution, sources, repo, git, commit, manifestPath, fleetReceipts, fleetLogs,
    alter(change, i = 1) { const r = JSON.parse(readFileSync(join(dirs[i], 'receipt.json'))); change(r); writeReceipt(i, r); },
    fleet(change, i = 1) { const r = JSON.parse(readFileSync(fleetReceipts[i])); change(r); json(fleetReceipts[i], r); },
    capture(change, i) {
      const path = join(dirs[i], '0.json'); const v = JSON.parse(readFileSync(path)); change(v); json(path, v);
      this.alter(r => r.fixtures[0].captureSha256 = sha256(readFileSync(path)), i);
    },
    compiler(change, i = 1) {
      const dir = dirs[i], lines = file => readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s));
      const events = lines('compiler-invocations.jsonl'), artifacts = lines('cargo-artifacts.jsonl');
      const context = JSON.parse(readFileSync(join(dir, 'compiler-context.json'))), files = JSON.parse(readFileSync(join(dir, 'compiler-artifact-hashes.json')));
      change({ events, artifacts, context, files });
      writeFileSync(join(dir, 'compiler-invocations.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
      writeFileSync(join(dir, 'cargo-artifacts.jsonl'), artifacts.map(e => JSON.stringify(e)).join('\n'));
      json(join(dir, 'compiler-context.json'), context); json(join(dir, 'compiler-artifact-hashes.json'), files);
      const updated = compilerEvidence(events, artifacts, context, files);
      this.alter(r => { r.compiler = { ...r.compiler, ...updated,
        invocationSha256: sha256(readFileSync(join(dir, 'compiler-invocations.jsonl'))),
        artifactEventsSha256: sha256(readFileSync(join(dir, 'cargo-artifacts.jsonl'))) }; }, i);
    },
    compare: (extra = {}) => compareReceipts(...dirs, base, branch, manifest, { gitRepository: repo, fleetReceipts, fleetLogs, manifestPath, ...extra }) };
}
// Only fixture setup uses a missing path; all verification reads are strict.
function readFileSyncSafe(path) {
  try { return readFileSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
