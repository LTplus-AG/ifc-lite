#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Explicit fleet/CI entry point. Never publishes; preserve all failures and skips.
// @unwired-by-design release qualification invoked under fleet admission by the release owner
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CRATES } from './lib/crates-io.mjs';
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
  for (const crate of CRATES) {
    run('cargo', ['package', '-p', crate, '--list']);
    run('cargo', ['publish', '-p', crate, '--dry-run', '--locked']);
  }
  run('cargo', ['publish', '-p', 'ifc-lite-geometry-runtime', '--features', 'retained-runtime', '--dry-run', '--locked']);
} else if (mode === 'cargo-graph') {
  // Cargo packages the selected interdependent crates together; this exercises
  // the real versioned archive graph before prerequisite versions are uploaded.
  // The separate single-crate mode still records current registry readiness.
  const packages = CRATES.flatMap(crate => ['-p', crate]);
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
} else throw new Error('Expected cargo, cargo-graph, build or npm');
writeFileSync(`retained-package-proof-${mode}.json`, `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every(result => result.exitCode === 0) ? 0 : 1;
