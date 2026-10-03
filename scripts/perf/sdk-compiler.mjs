/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { installedClosure } from './sdk-tools.mjs';
export async function compilerFreeze(root) {
  const command = (program, args) => execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 }).trim();
  const which = name => realpathSync(command('which', [name]));
  const binaries = { node: realpathSync(process.execPath), chrome: '/opt/google/chrome/chrome',
    rustup: which('rustup'), rustc: realpathSync(command('rustup', ['which', 'rustc'])),
    cargo: realpathSync(command('rustup', ['which', 'cargo'])), wasmPack: which('wasm-pack'), wasmBindgen: which('wasm-bindgen'), pnpm: which('pnpm') };
  const files = {}, linkedLibraries = {};
  for (const path of Object.values(binaries)) files[path] = await fileHash(path);
  for (const key of ['node', 'chrome', 'rustup', 'rustc', 'cargo', 'wasmPack', 'wasmBindgen']) {
    const observed = spawnSync('ldd', [binaries[key]], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 });
    if (observed.error) throw observed.error;
    const raw = `${observed.stdout}${observed.stderr}`.trim();
    if (observed.status !== 0 && !(observed.status === 1 && /^(?:statically linked|not a dynamic executable)$/.test(raw))) throw new Error('linked-library observation refused');
    if (/not found/.test(raw)) throw new Error('compiler/runtime linked library absent');
    linkedLibraries[key] = raw;
    for (const match of raw.matchAll(/(?:=>\s+|^\s*)(\/[^\s]+)\s/gm)) {
      const path = realpathSync(match[1]); files[path] = await fileHash(path);
    }
  }
  const sysroot = realpathSync(command(binaries.rustc, ['--print', 'sysroot']));
  let count = 0;
  async function walk(path, depth = 0) {
    if (depth > 32) throw new Error('compiler library depth bound');
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error('unsupported compiler-library symlink');
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) {
        if (++count > 100000) throw new Error('compiler library file bound');
        files[child] = await fileHash(child);
      }
    }
  }
  await walk(join(sysroot, 'lib'));
  let pnpmPackage = dirname(binaries.pnpm);
  for (let depth = 0; depth < 12; depth++, pnpmPackage = dirname(pnpmPackage)) {
    const manifest = join(pnpmPackage, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'pnpm') break;
  }
  if (!existsSync(join(pnpmPackage, 'package.json')) || JSON.parse(readFileSync(join(pnpmPackage, 'package.json'), 'utf8')).name !== 'pnpm') {
    throw new Error('actual pnpm package unresolved; proxy/shim not silently accepted');
  }
  const packageClosure = await installedClosure([{ name: 'pnpm', from: join(dirname(pnpmPackage), 'package.json') },
    ...['turbo', 'typescript', 'tsx'].map(name => ({ name, from: join(root, 'package.json') }))]);
  Object.assign(files, packageClosure.files);
  return { binaries, files, linkedLibraries, sysroot, compilerLibraryFiles: count, packageClosure,
    limitations: 'Pins consumed executables, resolved installed packages, observed ldd libraries and conservative Rust lib tree. Not a closed machine/environment/linker or Cargo-registry input proof; locked Cargo checksums and actual source-build receipts remain separate evidence.' };
}
