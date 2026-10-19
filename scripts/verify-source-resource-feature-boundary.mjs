#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Compiler evidence for the normal-library boundary, not source-text matching.
// Invoke inside the admitted build environment, as for every Cargo graph.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const targetDir = resolve(root, process.env.CARGO_TARGET_DIR || 'target');
const target = process.env.CARGO_BUILD_TARGET;
const targetName = target && basename(target).replace(/\.json$/, '');
const profileDir = join(targetDir, ...(targetName ? [targetName] : []), 'debug');
const scratch = mkdtempSync(join(tmpdir(), 'ifclite-source-feature-'));
const output = join(profileDir, 'deps', `${basename(scratch)}.rmeta`);
const source = join(scratch, 'probe.rs');
writeFileSync(source, `use ifc_lite_core::source_resource_gate_test_support::GateWitnessCase;
pub fn observed_case() -> GateWitnessCase { GateWitnessCase::Lifetime }
`);

const cases = [
  { name: 'default', features: [], available: false },
  { name: 'ordinary tracking', features: ['source-resource-tracking'], available: false },
  { name: 'explicit test support', features: ['source-resource-gate-test-support'], available: true },
];

try {
  for (const fixture of cases) {
    const build = spawnSync('cargo', [
      'build', '--locked', '-p', 'ifc-lite-core', '--lib', '--no-default-features',
      ...(fixture.features.length ? ['--features', fixture.features.join(',')] : []),
    ], { cwd: root, stdio: 'inherit' });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`${fixture.name}: normal-library build failed (${build.status})`);

    const library = join(profileDir, 'libifc_lite_core.rlib');
    if (!existsSync(library)) throw new Error(`${fixture.name}: built core library is missing: ${library}`);
    rmSync(output, { force: true });
    const probe = spawnSync('rustc', [
      '--edition=2021', '--crate-name', 'source_resource_feature_boundary',
      '--crate-type=lib', '--emit=metadata', '--error-format=json',
      ...(target ? ['--target', target] : []),
      source, '--extern', `ifc_lite_core=${library}`,
      '-L', `dependency=${join(profileDir, 'deps')}`, '-o', output,
    ], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (probe.error) throw probe.error;
    if (fixture.available) {
      if (probe.status !== 0 || !existsSync(output)) {
        throw new Error(`${fixture.name}: expected the opted-in API to compile\n${probe.stderr}`);
      }
    } else {
      const errors = probe.stderr.trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(item => item.level === 'error' && item.code);
      if (probe.status !== 1 || errors.length !== 1 || errors[0].code.code !== 'E0432'
          || !errors[0].message.includes('source_resource_gate_test_support')) {
        throw new Error(`${fixture.name}: expected only the absent-module compiler error\n${probe.stderr}`);
      }
    }
    console.log(`${fixture.name}: normal-library test-support API ${fixture.available ? 'present' : 'absent'} (compiler verified)`);
  }
} finally {
  // Only this invocation's tiny probe inputs/metadata are removed. Cargo output
  // remains in the registered target under its normal lifecycle ownership.
  rmSync(output, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
