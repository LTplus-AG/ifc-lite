/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Synthetic files and terminal compiler events for protocol tests, never builds.
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sha256 } from '../exact-route-source.mjs';
import { packageInputs, digest } from '../exact-route-inputs.mjs';
export const profile = () => ({ debug_assertions: false, test: false, opt_level: '3', debuginfo: null, overflow_checks: false });
export function writeCompilerSources(repo) {
  for (const name of ['core', 'geometry', 'processing']) {
    const root = join(repo, 'rust', name); mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'Cargo.toml'), `[package]\nname = "ifc-lite-${name}"\nversion = "1.0.0"\n`);
    writeFileSync(join(root, 'src/lib.rs'), `// ${name} protocol fixture\n`);
  }
}
export function unitFixture(repo, output, source, environment = {}) {
  const external = join(dirname(repo), 'external-fixture'); mkdirSync(external, { recursive: true });
  writeFileSync(join(external, 'Cargo.toml'), '[package]\nname = "external-fixture"\nversion = "1.0.0"\n');
  writeFileSync(join(external, 'lib.rs'), '// external protocol source\n');
  const context = { format: 'exact-route-compile-context-v1', workspaceRoot: repo, source, environment,
    toolchain: 'fixture rustc', cargo: 'fixture cargo', configuration: {} };
  const events = [], artifacts = [], files = {};
  const specs = [{ name: 'external-fixture', root: external, path: 'lib.rs' },
    ...['core', ...(existsSync(join(repo, 'rust/imported-geometry')) ? ['imported-geometry'] : []), 'geometry', ...(existsSync(join(repo, 'rust/geometry-runtime')) ? ['geometry-runtime'] : []), 'processing'].map(name => ({ name: `ifc-lite-${name}`, root: join(repo, 'rust', name), path: 'src/lib.rs' })),
    { name: 'ifc-lite-processing', root: join(repo, 'rust/processing'), path: 'examples/exact_route_capture.rs', example: true }];
  mkdirSync(join(output, 'artifacts'), { recursive: true });
  for (const spec of specs) {
    const crate = spec.example ? 'exact_route_capture' : spec.name.replaceAll('-', '_');
    const file = join(output, 'artifacts', spec.example ? `${crate}-fixture` : `lib${crate}-fixture.rlib`);
    writeFileSync(file, `${crate} protocol artifact`); files[file] = sha256(readFileSync(file));
    const args = ['--crate-name', crate, join(spec.root, spec.path), '--out-dir', join(output, 'artifacts'),
      '--crate-type', spec.example ? 'bin' : 'lib', '-C', 'opt-level=3', '-C', 'extra-filename=-fixture'];
    const externInputs = {};
    if (['ifc-lite-processing', 'ifc-lite-geometry', 'ifc-lite-geometry-runtime'].includes(spec.name)) {
      for (const dep of artifacts.filter(a => !a.executable && ((spec.name === 'ifc-lite-processing' && a.target.name !== 'ifc-lite-imported-geometry') ||
          (spec.name === 'ifc-lite-geometry' && a.target.name === 'ifc-lite-imported-geometry') ||
          (spec.name === 'ifc-lite-geometry-runtime' && a.target.name === 'ifc-lite-geometry')))) {
        args.push('--extern', `${dep.target.name.replaceAll('-', '_')}=${dep.filenames[0]}`);
        externInputs[dep.filenames[0]] = files[dep.filenames[0]];
      }
    }
    const inputs = packageInputs(spec.root);
    events.push({ compiler: 'rustc', version: context.toolchain, args, cwd: repo,
      package: { name: spec.name, version: '1.0.0', root: spec.root }, contextSha256: digest(context), status: 0, signal: null,
      generatedRoot: null, generatedInputsBefore: null, generatedInputsAfter: null,
      inputsBefore: inputs, inputsAfter: structuredClone(inputs), configurationBefore: {}, configurationAfter: {},
      externInputs, externAfter: structuredClone(externInputs), outputs: { [file]: files[file] } });
    artifacts.push({ reason: 'compiler-artifact', package_id: `${spec.root === external ? 'registry+fixture' : `path+file://${spec.root}`}#${spec.name}@1.0.0`,
      target: { name: spec.example ? 'exact_route_capture' : spec.name, kind: [spec.example ? 'example' : 'lib'], src_path: join(spec.root, spec.path) },
      executable: spec.example ? file : null, filenames: [file], fresh: false, features: [], profile: profile() });
  }
  return { events, artifacts, files, context };
}

export function compilerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'exact-route-compiler-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo); writeFileSync(join(repo, 'Cargo.toml'), '// root protocol manifest');
  writeCompilerSources(repo); mkdirSync(join(repo, 'rust/processing/examples'), { recursive: true });
  writeFileSync(join(repo, 'rust/processing/examples/exact_route_capture.rs'), '// example protocol source');
  return unitFixture(repo, join(root, 'output'), { trackedSourceHashes: packageInputs(repo) });
}
