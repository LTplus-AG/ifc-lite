#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Explicit fleet/CI entry point. Never publishes; preserve all failures and skips.
// @unwired-by-design release qualification invoked under fleet admission by the release owner
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CRATES } from './lib/crates-io.mjs';
// Qualification includes the bootstrap candidate without enrolling it in the
// always-on semver/publish gates before a registry baseline exists.
const qualificationCrates = [...new Set(CRATES.flatMap(crate => crate === 'ifc-lite-geometry'
  ? [crate, 'ifc-lite-geometry-runtime'] : [crate]))];
const results = [];
function run(command, args) {
  console.log(`\nPROOF_COMMAND ${JSON.stringify([command, ...args])}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  const record = { command: [command, ...args], exitCode: result.status, signal: result.signal, error: result.error?.message };
  results.push(record);
  console.log(`PROOF_RESULT ${JSON.stringify(record)}`);
}
const mode = process.argv[2];
if (mode === 'cargo') {
  for (const crate of qualificationCrates) {
    run('cargo', ['package', '-p', crate, '--list']);
    run('cargo', ['publish', '-p', crate, '--dry-run', '--locked']);
  }
  run('cargo', ['publish', '-p', 'ifc-lite-geometry-runtime', '--features', 'retained-runtime', '--dry-run', '--locked']);
} else if (mode === 'cargo-graph') {
  // Cargo packages the selected interdependent crates together; this exercises
  // the real versioned archive graph before prerequisite versions are uploaded.
  // The separate single-crate mode still records current registry readiness.
  const packages = qualificationCrates.flatMap(crate => ['-p', crate]);
  run('cargo', ['publish', '--dry-run', '--locked', ...packages]);
  run('cargo', ['publish', '--dry-run', '--locked', ...packages, '--features',
    'ifc-lite-geometry-runtime/retained-runtime,ifc-lite-processing/retained-runtime,ifc-lite-wasm/retained-browser']);
} else if (mode === 'build') {
  run('cargo', ['test', '--workspace']);
  run('cargo', ['build', '--manifest-path', 'rust/python/Cargo.toml', '--locked']);
  run('cargo', ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings']);
} else if (mode === 'npm') {
  run('pnpm', ['build', '--filter=@ifc-lite/cli...', '--filter=@ifc-lite/wasm']);
  for (const pkg of ['wasm', 'cli']) run('npm', ['pack', '--dry-run', '--json', `./packages/${pkg}`]);
} else if (mode === 'review') {
  run('node', ['scripts/retained-notices.mjs', '--check']);
  run('node', ['--test', 'scripts/retained-notices.test.mjs',
    'scripts/stage-cli-retained-engine.test.mjs', 'scripts/stage-retained-browser-assets.test.mjs']);
  for (const script of ['docs/check-mkdocs-nav', 'check-ci-path-coverage', 'check-rust-semver', 'check-rust-api-surface']) {
    run('node', [`scripts/${script}.mjs`]);
  }
} else if (mode === 'docs') {
  // Match docs.yml: pinned repository requirements and generated API pages.
  // Isolate Python dependencies without modifying the worker's system Python.
  const venv = mkdtempSync(join(tmpdir(), 'retained-docs-'));
  try {
    run('python3', ['-m', 'venv', venv]);
    const python = join(venv, 'bin/python');
    run(python, ['-m', 'pip', 'install', '-r', 'requirements-docs.txt']);
    run('pnpm', ['docs:api']);
    run(python, ['-m', 'mkdocs', 'build', '--strict']);
  } finally { rmSync(venv, { recursive: true, force: true }); }
} else throw new Error('Expected cargo, cargo-graph, build, npm, review or docs');
writeFileSync(`retained-package-proof-${mode}.json`, `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;
