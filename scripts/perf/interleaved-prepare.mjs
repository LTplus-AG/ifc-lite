/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { FIXTURES, LIMITS, immutableRef, schedule } from './interleaved-plan.mjs';
import { fileHash, inventory } from './interleaved-assets.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'interleaved-results');
mkdirSync(output, { recursive: true });
const run = (program, args, cwd = root) => execFileSync(program, args, { cwd, encoding: 'utf8' }).trim();
const revisions = { base: immutableRef(process.env.BASE_REF), candidate: immutableRef(process.env.CANDIDATE_REF) };
const dirs = { base: resolve(process.env.BASE_DIR ?? '../interleaved-base'), candidate: resolve(process.env.CANDIDATE_DIR ?? '../interleaved-candidate') };
const mode = process.argv[2];
if (mode === 'validate-inputs') {
  if (revisions.base === revisions.candidate) throw new Error('REFUSE: candidate must differ from base; A/A is already scheduled');
  writeFileSync(join(output, 'protocol.json'), JSON.stringify({ revisions, limits: LIMITS, schedule: schedule() }, null, 2));
} else if (mode === 'mark-builds') {
  for (const arm of ['base', 'candidate']) {
    if (run('git', ['rev-parse', 'HEAD'], dirs[arm]) !== revisions[arm]) throw new Error('REFUSE: checkout revision mismatch');
    for (const path of ['rust-toolchain.toml', '.github/actions/setup-wasm-build/action.yml']) {
      if (readFileSync(join(dirs[arm], path), 'utf8') !== readFileSync(join(root, path), 'utf8')) {
        throw new Error(`REFUSE: ${arm} differs from harness pinned toolchain action: ${path}`);
      }
    }
  }
  writeFileSync(join(output, 'build-start.json'), JSON.stringify({ timestampMs: Date.now(), dirs, revisions }, null, 2));
} else if (mode === 'fixtures') {
  // Canonical exact-public-manifest fetch; no fallback fixture or synthetic substitute.
  execFileSync('node', ['scripts/fixtures/fetch-fixtures.mjs', ...FIXTURES.map(fixture => fixture.path)], { cwd: root, stdio: 'inherit' });
  execFileSync('node', ['scripts/fixtures/fetch-fixtures.mjs', '--check', ...FIXTURES.map(fixture => fixture.path)], { cwd: root, stdio: 'inherit' });
} else if (mode === 'freeze') {
  const start = JSON.parse(readFileSync(join(output, 'build-start.json'), 'utf8'));
  const builds = {};
  for (const arm of ['base', 'candidate']) {
    const dir = dirs[arm];
    if (run('git', ['rev-parse', 'HEAD'], dir) !== revisions[arm]) throw new Error('REFUSE: checkout moved during build');
    if (run('git', ['status', '--porcelain', '--untracked-files=no'], dir)) throw new Error('REFUSE: tracked source changed during build');
    const wasm = join(dir, 'packages/wasm/pkg/ifc-lite_bg.wasm');
    if (statSync(wasm).mtimeMs < start.timestampMs) throw new Error('REFUSE: WASM predates source build start');
    const viewer = await inventory(join(dir, 'apps/viewer/dist'));
    const wasmHash = await fileHash(wasm);
    if (!viewer.some(file => file.path.endsWith('.wasm') && file.sha256 === wasmHash)) throw new Error('REFUSE: viewer does not serve freshly built default WASM');
    builds[arm] = { revision: revisions[arm], dir, sourceTree: run('git', ['rev-parse', 'HEAD^{tree}'], dir),
      wasmSha256: wasmHash, viewer, lockSha256: await fileHash(join(dir, 'pnpm-lock.yaml')),
      cargoLockSha256: await fileHash(join(dir, 'Cargo.lock')), rustToolchain: readFileSync(join(dir, 'rust-toolchain.toml'), 'utf8') };
  }
  const manifest = JSON.parse(readFileSync(join(root, 'tests/models/manifest.json'), 'utf8'));
  const fixtures = [];
  for (const fixture of FIXTURES) {
    const entry = manifest.files.find(file => file.path === fixture.path);
    if (!entry || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error('REFUSE: fixed fixture absent from public manifest');
    const path = join(root, 'tests/models', fixture.path);
    if (statSync(path).size !== entry.size || await fileHash(path) !== entry.sha256) throw new Error('REFUSE: public fixture bytes differ');
    fixtures.push({ ...fixture, ...entry, file: path, provenance: { release: manifest.release_tag, baseUrl: manifest.base_url } });
  }
  const provenance = { harnessRevision: run('git', ['rev-parse', 'HEAD']),
    harnessSourceTree: run('git', ['rev-parse', 'HEAD^{tree}']), builds, fixtures,
    manifestSha256: await fileHash(join(root, 'tests/models/manifest.json')),
    runtime: { node: process.version, pnpm: run('pnpm', ['--version']), rust: run('rustc', ['--version']),
      wasmPack: run('wasm-pack', ['--version']), chrome: run('google-chrome', ['--version']),
      chromeExecutableSha256: await fileHash('/opt/google/chrome/chrome'),
      kernel: run('uname', ['-a']), cpu: readFileSync('/proc/cpuinfo', 'utf8'),
      memory: readFileSync('/proc/meminfo', 'utf8'), renderer: 'Chrome channel, headless SwiftShader',
      environment: 'same ubuntu-24.04 GitHub-hosted job; production builds; default worker pool' },
    frozenAt: new Date().toISOString(), buildStartedAt: new Date(start.timestampMs).toISOString(), limits: LIMITS };
  writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2));
} else throw new Error('Expected validate-inputs, mark-builds, fixtures or freeze');
