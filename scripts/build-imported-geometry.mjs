/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regeneration is a heavy operation: invoke under the project fleet admission.
// Normal package builds only verify the committed artifact, requiring no Rust.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { provisionWasm2js, publishGenerated, wrapTranslator } from './lib/imported-artifacts.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'packages/ifcx/src/generated');
const sourceFiles = ['Cargo.toml', 'Cargo.lock', '.cargo/config.toml', 'scripts/build-imported-geometry.mjs', 'scripts/lib/imported-artifacts.mjs', 'rust-toolchain.toml', 'rust/imported-geometry/Cargo.toml',
  ...readdirSync(resolve(root, 'rust/imported-geometry/src')).filter(name => name.endsWith('.rs')).sort().map(name => `rust/imported-geometry/src/${name}`)];
const digest = data => createHash('sha256').update(data).digest('hex');
const sources = Object.fromEntries(sourceFiles.map(name => [name, digest(readFileSync(resolve(root, name)))]));
if (process.argv.includes('--copy')) {
  mkdirSync(resolve(root, 'packages/ifcx/dist/generated'), { recursive: true });
  copyFileSync(resolve(directory, 'imported-geometry-static.js'), resolve(root, 'packages/ifcx/dist/generated/imported-geometry-static.js'));
} else if (process.argv.includes('--verify')) {
  const provenance = JSON.parse(readFileSync(resolve(directory, 'imported-geometry.provenance.json'), 'utf8'));
  if (JSON.stringify(sources) !== JSON.stringify(provenance.sources)) throw new Error('Imported geometry Rust sources changed: regenerate with pnpm build:imported-geometry under fleet admission');
  const moduleText = readFileSync(resolve(directory, 'imported-geometry.ts'), 'utf8');
  const base64 = moduleText.match(/const base64 = '([^']+)'/u)?.[1];
  if (!base64 || digest(Buffer.from(base64, 'base64')) !== provenance.wasmSha256) throw new Error('Imported geometry artifact digest mismatch');
  if (digest(readFileSync(resolve(directory, 'imported-geometry-static.js'))) !== provenance.staticSha256) throw new Error('Imported geometry static artifact digest mismatch');
  for (const [name, expected] of Object.entries(provenance.artifacts)) {
    if (digest(readFileSync(resolve(directory, name))) !== expected) throw new Error(`Imported geometry artifact digest mismatch: ${name}`);
  }
  console.log(`Imported geometry artifact verified (${provenance.wasmBytes} wasm bytes; Rust-free)`);
} else {
  const wasm2js = await provisionWasm2js();
  const wasm2jsSha256 = digest(readFileSync(wasm2js));
  const args = ['build', '--locked', '-p', 'ifc-lite-imported-geometry', '--target', 'wasm32-unknown-unknown', '--release'];
  // Cargo appends repository rustflags after rustc CLI options, so use its
  // documented highest-priority encoded flag channel for this scalar target.
  const rustflags = ['-C', 'link-arg=--max-memory=4294967296', '-C', 'link-arg=-zstack-size=1048576', '-C', 'target-feature=-simd128'];
  const build = spawnSync('cargo', args, { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags.join('\u001f') } });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const target = process.env.CARGO_TARGET_DIR || resolve(root, 'target');
  const bytes = readFileSync(resolve(target, 'wasm32-unknown-unknown/release/ifc_lite_imported_geometry.wasm'));
  const module = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(module);
  for (const [name, kind] of [['memory', 'memory'], ['imported_alloc', 'function'], ['imported_free', 'function'], ['imported_run', 'function']]) {
    if (!exports.some(entry => entry.name === name && entry.kind === kind)) throw new Error(`Imported geometry WASM ABI missing ${name}`);
  }
  if (WebAssembly.Module.imports(module).length) throw new Error('Synchronous artifact must not require host imports');
  publishGenerated(directory, directory => {
    const staticOutput = resolve(directory, 'imported-geometry-static.js');
    const wasm2jsArgs = ['--all-features', '-O', '--deterministic'];
    const translate = spawnSync(wasm2js, [resolve(target, 'wasm32-unknown-unknown/release/ifc_lite_imported_geometry.wasm'), ...wasm2jsArgs, '-o', staticOutput], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (translate.status !== 0) {
      const log = resolve(target, `imported-geometry-${process.pid}.translation.log`);
      writeFileSync(log, (translate.stdout || '') + (translate.stderr || ''));
      process.stderr.write((translate.stderr || String(translate.error)).slice(0, 6000));
      process.stderr.write(`\nComplete translator diagnostics: ${log}\n`);
    }
    if (translate.status !== 0) throw new Error('Imported geometry translation failed; previous artifacts preserved');
    const compiler = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
    if (compiler.status !== 0) throw new Error('Cannot identify Rust compiler');
    const header = '/* This Source Code Form is subject to the terms of the Mozilla Public\n * License, v. 2.0. If a copy of the MPL was not distributed with this\n * file, You can obtain one at https://mozilla.org/MPL/2.0/. */\n';
    const generated = `${header}\n// Generated by scripts/build-imported-geometry.mjs. Do not edit.\nconst base64 = '${bytes.toString('base64')}';\nexport function importedGeometryBytes(): Uint8Array<ArrayBuffer> {\n  const binary = atob(base64);\n  const bytes = new Uint8Array(binary.length);\n  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);\n  return bytes;\n}\n`;
    writeFileSync(resolve(directory, 'imported-geometry.ts'), generated);
    // The pinned translator emits export-var glue. Move that glue and all of its
    // helper allocation inside a factory; no numerical expression is rewritten.
    const translated = readFileSync(staticOutput, 'utf8').replace(/[ \t]+$/gmu, '');
    const lazyModule = wrapTranslator(translated);
    writeFileSync(staticOutput, header + '\n// Generated from the same Rust WASM by pinned Binaryen wasm2js. Do not edit.\n' + lazyModule);
    const syntax = spawnSync(process.execPath, ['--check', staticOutput], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`Generated static module is invalid: ${syntax.stderr}`);
    const staticBytes = readFileSync(staticOutput);
    writeFileSync(resolve(directory, 'imported-geometry-static.d.ts'), header + '\nexport function createImportedGeometryKernel(): {\n  memory: { readonly buffer: ArrayBuffer };\n  imported_alloc(length: number): number;\n  imported_free(pointer: number, length: number): void;\n  imported_run(pointer: number, length: number): number;\n};\n');
    writeFileSync(resolve(directory, 'imported-geometry.provenance.json'), `${JSON.stringify({ abi: 1, compiler: compiler.stdout.trim(), target: 'wasm32-unknown-unknown', profile: 'release', command: ['cargo', ...args], rustflags, wasm2jsArgs, wasm2jsSha256, wasm2jsVersion: spawnSync(wasm2js, ['--version'], { encoding: 'utf8' }).stdout.trim(), staticSha256: digest(staticBytes), staticBytes: staticBytes.length, wasmBytes: bytes.length, wasmSha256: digest(bytes), sources, artifacts: Object.fromEntries(['imported-geometry.ts', 'imported-geometry-static.js', 'imported-geometry-static.d.ts'].map(name => [name, digest(readFileSync(resolve(directory, name)))])) }, null, 2)}\n`);
  });
  console.log(`Generated ${bytes.length} byte synchronous imported Rust WASM artifact`);
}
