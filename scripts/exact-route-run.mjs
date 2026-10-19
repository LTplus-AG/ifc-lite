/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Run ONLY inside the parent's fleet admission. This file never acquires a job.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism, hostname } from 'node:os';
import { gitSource, verifyWorktree, verifyHarnessManifest } from './exact-route-source.mjs';
import { compilerEnvironment, compilerEvidence } from './exact-route-compiler.mjs';
import { cargoConfiguration, artifactHashes, digest } from './exact-route-inputs.mjs';
import { executeSavedBinary, saveCompiledBinary, verifyBinary } from './exact-route-binary.mjs';
import { validateCapture } from './exact-route-schema.mjs';
const bundle = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = 'docs/architecture/evidence/exact-route-preservation-c676220d-r5-graph/manifest.json';
const manifest = JSON.parse(readFileSync(resolve(bundle, manifestPath)));
const hash = data => createHash('sha256').update(data).digest('hex');
function command(cwd, executable, args) {
  const r = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(`${executable} ${args.join(' ')}: ${r.error ?? r.stderr}`);
  return r.stdout.trim();
}
function checkedBundle() {
  verifyHarnessManifest(manifest);
  const artifact = manifest.overlayArtifact;
  if (hash(readFileSync(resolve(bundle, artifact.path))) !== artifact.sha256) throw Error('overlay artifact drift');
  for (const [path, sha] of Object.entries(manifest.harness)) {
    if (hash(readFileSync(resolve(bundle, path))) !== sha) throw Error(`harness source drift: ${path}`);
  }
  for (const fixture of manifest.fixtures) {
    if (hash(readFileSync(resolve(bundle, fixture.path))) !== fixture.sha256) throw Error(`fixture drift: ${fixture.path}`);
  }
}
function prepare(cwd, expectedHead) {
  if (command(cwd, 'git', ['rev-parse', 'HEAD']) !== expectedHead) throw Error('wrong checkout HEAD');
  if (command(cwd, 'git', ['status', '--porcelain'])) throw Error('prepare requires a clean isolated source checkout');
  for (const path of manifest.overlay) {
    const target = resolve(cwd, path);
    if (existsSync(target)) {
      if (hash(readFileSync(target)) !== manifest.harness[path]) throw Error(`existing overlay mismatch: ${path}`);
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(resolve(bundle, path)), { flag: 'wx' });
    }
  }
  command(cwd, 'git', ['add', '--', ...manifest.overlay]);
  if (command(cwd, 'git', ['diff', '--cached', '--name-only'])) {
    command(cwd, 'git', ['commit', '-m', 'Verification-only exact-route source overlay']);
  }
  const source = gitSource(cwd, expectedHead, command(cwd, 'git', ['rev-parse', 'HEAD']), manifest);
  verifyWorktree(cwd, source);
  console.log(JSON.stringify({ ...source, note: 'clean committed overlay; NO compilation or execution' }, null, 2));
}
function run(cwd, expectedHead, output) {
  const source = gitSource(cwd, expectedHead, command(cwd, 'git', ['rev-parse', 'HEAD']), manifest);
  verifyWorktree(cwd, source);
  const environment = compilerEnvironment(process.env);
  if (existsSync(output)) throw Error('output directory exists; preserve original receipt');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const receipt = { protocol: 'exact-route-v2', status: 'started', ...source, cwd,
    requestedCommand: ['node', fileURLToPath(import.meta.url), 'run', cwd, expectedHead, output],
    harnessSha256: manifest.harnessSha256,
    runtime: { platform: process.platform, arch: process.arch, availableParallelism: availableParallelism() },
    host: hostname(),
    harness: manifest.harness,
    manifestSha256: hash(readFileSync(resolve(bundle, manifestPath))),
    toolchain: command(cwd, 'rustc', ['-vV']), cargo: command(cwd, 'cargo', ['-V']),
    environment,
    options: manifest.options, fixtures: [], commands: [],
  };
  const save = () => writeFileSync(resolve(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  save();
  try {
    // Force a reached example compilation without changing any source bytes.
    // A cached example cannot supply this run's actual compiler arguments.
    const now = new Date();
    utimesSync(resolve(cwd, manifest.overlay[0]), now, now);
    receipt.freshnessOnlyMtimePath = manifest.overlay[0]; save();
    const args = ['build', '-vv', '--locked', '--profile', 'server-release', '-p', 'ifc-lite-processing',
      '--example', 'exact_route_capture', '--message-format=json'];
    receipt.commands.push(['cargo', ...args]); save();
    const compilerLog = resolve(output, 'compiler-invocations.jsonl');
    const context = { format: 'exact-route-compile-context-v1', workspaceRoot: cwd, source, environment,
      toolchain: receipt.toolchain, cargo: receipt.cargo, configuration: cargoConfiguration(cwd) };
    const contextFile = resolve(output, 'compiler-context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    receipt.compilerContextSha256 = digest(context); save();
    const build = spawnSync('cargo', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, RUSTC_WRAPPER: resolve(bundle, 'scripts/exact-route-rustc.mjs'), EXACT_ROUTE_RUSTC_LOG: compilerLog, EXACT_ROUTE_CONTEXT_FILE: contextFile } });
    writeFileSync(resolve(output, 'cargo-stderr.log'), build.stderr ?? '');
    const built = build.stdout ?? '';
    writeFileSync(resolve(output, 'cargo-artifacts.jsonl'), built);
    if (build.error || build.status !== 0) throw Error(`build failed: ${build.error ?? build.status}; see cargo-stderr.log`);
    const artifacts = built.split('\n').filter(Boolean).map(s => JSON.parse(s));
    const events = readFileSync(compilerLog, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
    const files = artifactHashes(artifacts);
    writeFileSync(resolve(output, 'compiler-artifact-hashes.json'), JSON.stringify(files));
    if (digest(cargoConfiguration(cwd)) !== digest(context.configuration)) throw Error('Cargo configuration changed during build');
    const evidence = compilerEvidence(events, artifacts, context, files);
    receipt.compiler = { ...evidence, invocationSha256: hash(readFileSync(compilerLog)),
      artifactEventsSha256: hash(readFileSync(resolve(output, 'cargo-artifacts.jsonl'))),
      verboseLogSha256: hash(readFileSync(resolve(output, 'cargo-stderr.log'))) }; save();
    const binary = artifacts.findLast(a => a.reason === 'compiler-artifact' &&
      a.target.name === 'exact_route_capture' && a.executable)?.executable;
    if (!binary) throw Error('no compiler-reported executable');
    receipt.binary = saveCompiledBinary(binary, resolve(output, 'capture-binary'), files[binary]); save();
    for (const [i, fixture] of manifest.fixtures.entries()) {
      const capture = resolve(output, `${i}.json`);
      const fixturePath = resolve(bundle, fixture.path);
      receipt.commands.push([receipt.binary.executedPath, fixturePath, capture]); save();
      const { execution, provenance } = executeSavedBinary(receipt.binary, [fixturePath, capture], cwd);
      writeFileSync(resolve(output, `${i}.stdout.log`), execution.stdout ?? '');
      writeFileSync(resolve(output, `${i}.stderr.log`), execution.stderr ?? '');
      if (execution.error || execution.status !== 0) throw Error(`fixture ${i} failed: ${execution.error ?? execution.status}`);
      const parsed = JSON.parse(readFileSync(capture)); validateCapture(parsed, manifest.options);
      const scene = parsed.scene;
      const coverage = { meshes: scene.meshes.length,
        uvs: scene.meshes.filter(m => m.serialized.uvs).length,
        uvValues: scene.meshes.reduce((n, m) => n + (m.serialized.uvs?.length ?? 0), 0),
        textureBytes: scene.meshes.reduce((n, m) => n + (m.serialized.texture?.rgba?.length ?? 0), 0),
        textures: scene.meshes.filter(m => m.serialized.texture).length,
        instanceMetadata: scene.meshes.filter(m => m.instance_transform_local_canonical_identity_shareable).length,
        instanceRecords: scene.instances_id_type_guid_name_layer_color_template_identity_transform_item.length,
        geometryClasses: [...new Set(scene.meshes.map(m => m.geometry_class))],
        frame: scene.frame_variant_anchor_placement, lossAndDiagnostics: scene.stats };
      receipt.fixtures.push({ ...fixture, execution: provenance, capture: `${i}.json`, captureSha256: hash(readFileSync(capture)), coverage }); save();
    }
    verifyBinary(receipt.binary.executedPath, receipt.binary.sha256);
    verifyWorktree(cwd, source);
    receipt.status = 'captured-uncompared';
  } catch (error) { receipt.status = 'FAILED'; receipt.error = error.message; process.exitCode = 1; }
  save();
  console.log(`EXACT_ROUTE_RECEIPT_SHA256 ${hash(readFileSync(resolve(output, 'receipt.json')))}`);
}
try {
  const [mode, checkout, head, output] = process.argv.slice(2);
  if (!['prepare', 'run'].includes(mode) || !checkout || !/^[0-9a-f]{40}$/.test(head ?? '') ||
      (mode === 'run' && !output)) throw Error('usage: exact-route-run.mjs prepare|run CHECKOUT FULL_EXPECTED_HEAD [NEW_OUTPUT_DIR]');
  checkedBundle();
  if (mode === 'prepare') prepare(resolve(checkout), head);
  else run(resolve(checkout), head, resolve(output));
} catch (error) { console.error(error.message); process.exitCode = 1; }
