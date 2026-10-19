/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { compilerFixture, profile } from './lib/exact-route-unit-fixture.mjs';
import { compilerEvidence } from './exact-route-compiler.mjs';
import { compareUnitPolicies } from './exact-route-units.mjs';
import { sysrootInputs } from './exact-route-externs.mjs';
import { sha256 } from './exact-route-source.mjs';
const evidence = f => compilerEvidence(f.events, f.artifacts, f.context, f.files);
function hostArtifacts(f) {
  const unit = structuredClone(f.artifacts[0]), event = structuredClone(f.events[0]);
  const source = join(event.package.root, 'build.rs'), terminal = join(dirname(unit.filenames[0]), 'build_script_build-fixture');
  const copied = join(dirname(unit.filenames[0]), 'build-script-build');
  event.inputsBefore['build.rs'] = event.inputsAfter['build.rs'] = sha256('// source-evident build script');
  event.args = ['--crate-name', 'build_script_build', source, '--out-dir', dirname(terminal), '--crate-type', 'bin', '-C', 'opt-level=3'];
  event.outputs = { [terminal]: sha256('compiled host executable') };
  f.files[copied] = sha256('compiled host executable');
  unit.target = { name: 'build-script-build', kind: ['custom-build'], src_path: source };
  unit.filenames = [copied]; unit.executable = copied; unit.profile = profile();
  f.events.push(event); f.artifacts.push(unit);
  // Cargo reports a proc-macro shared library and --extern passes that .so
  // to the downstream target compiler, not an rlib guessed from its name.
  const macro = structuredClone(f.artifacts[0]), compile = structuredClone(f.events[0]);
  const macroSource = join(compile.package.root, 'macro.rs'), library = join(dirname(terminal), 'libfixture_macro-fixture.so');
  compile.inputsBefore['macro.rs'] = compile.inputsAfter['macro.rs'] = sha256('// proc macro source');
  compile.args = ['--crate-name', 'fixture_macro', macroSource, '--out-dir', dirname(library), '--crate-type', 'proc-macro', '--extern', 'proc_macro', '-C', 'opt-level=3'];
  const sysroot = dirname(library), procMacro = join(sysroot, 'libproc_macro-0123abcd.rlib');
  writeFileSync(procMacro, 'toolchain proc macro bytes');
  compile.sysrootExternsBefore = sysrootInputs('fixture-rustc', compile.args, () => ({ status: 0, stdout: sysroot }));
  compile.sysrootExternsAfter = structuredClone(compile.sysrootExternsBefore);
  compile.outputs = { [library]: sha256('proc macro shared object') }; f.files[library] = compile.outputs[library];
  macro.target = { name: 'fixture_macro', kind: ['proc-macro'], src_path: macroSource }; macro.filenames = [library];
  f.events.push(compile); f.artifacts.push(macro);
  f.events.at(-3).args.push('--extern', `fixture_macro=${library}`);
  f.events.at(-3).externInputs[library] = f.events.at(-3).externAfter[library] = f.files[library];
  return { compile, copied };
}
test('Cargo host build-script copy, proc-macro shared object, and bare sysroot proc_macro are explicitly bound', t => {
  const a = compilerFixture(t), b = compilerFixture(t); hostArtifacts(a); hostArtifacts(b);
  assert.doesNotThrow(() => compareUnitPolicies(evidence(a).units, evidence(b).units));
  assert.equal(evidence(a).units.length, 7);
});
for (const change of ['bytes', 'query', 'missing', 'unknown', 'build-copy']) test(`Cargo host artifact shape refuses ${change}`, t => {
  const f = compilerFixture(t), { compile, copied } = hostArtifacts(f);
  if (change === 'bytes') compile.sysrootExternsAfter[0].sha256 = 'a'.repeat(64);
  if (change === 'query') compile.sysrootExternsBefore[0].query.push('--target', 'foreign');
  if (change === 'missing') delete compile.sysrootExternsBefore;
  if (change === 'unknown') compile.args[compile.args.indexOf('proc_macro')] = 'unqualified_crate';
  if (change === 'build-copy') f.files[copied] = 'a'.repeat(64);
  assert.throws(() => evidence(f));
});
test('different toolchain sysroot bytes cannot hide behind same rustc version', t => {
  const a = compilerFixture(t), b = compilerFixture(t); hostArtifacts(a); const { compile } = hostArtifacts(b);
  compile.sysrootExternsBefore[0].sha256 = compile.sysrootExternsAfter[0].sha256 = 'a'.repeat(64);
  assert.throws(() => compareUnitPolicies(evidence(a).units, evidence(b).units));
});
