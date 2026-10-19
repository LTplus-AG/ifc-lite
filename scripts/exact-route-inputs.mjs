/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { sha256 } from './exact-route-source.mjs';
export const canonical = v => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
export const digest = v => sha256(canonical(v));
export function directoryInputs(root, packageRoot = false) {
  const files = {};
  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      // Cargo-managed outputs and registry download bookkeeping are not inputs.
      if (!prefix && packageRoot && ['.git', 'target', 'node_modules', '.cargo-ok'].includes(name)) continue;
      const path = join(directory, name), key = prefix ? `${prefix}/${name}` : name, info = lstatSync(path);
      if (info.isSymbolicLink()) throw Error(`unbound package source symlink: ${path}`);
      if (info.isDirectory()) walk(path, key);
      else if (info.isFile()) files[key] = sha256(readFileSync(path));
      else throw Error(`unsupported package input: ${path}`);
    }
  }
  walk(root, '');
  if (packageRoot && !Object.hasOwn(files, 'Cargo.toml')) throw Error('package source snapshot lacks manifest');
  return files;
}
export const packageInputs = root => directoryInputs(root, true);
export function cargoConfiguration(cwd, env = process.env) {
  const inputs = {};
  let directory = resolve(cwd);
  for (;;) {
    for (const name of ['config', 'config.toml']) {
      const path = join(directory, '.cargo', name);
      if (existsSync(path)) inputs[path] = sha256(readFileSync(path));
    }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  for (const name of ['config', 'config.toml']) {
    const path = join(env.CARGO_HOME ?? join(homedir(), '.cargo'), name);
    if (existsSync(path)) inputs[path] = sha256(readFileSync(path));
  }
  return inputs;
}
export function compilerOutputs(args, cwd) {
  const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
  const crate = option('--crate-name'), out = option('--out-dir');
  if (!crate || !out) return {};
  let suffix = '';
  for (let i = 0; i < args.length; i++) {
    const value = args[i] === '-C' ? args[i + 1] : args[i].startsWith('-C') ? args[i].slice(2) : '';
    if (value?.startsWith('extra-filename=')) suffix = value.slice('extra-filename='.length);
  }
  const base = `${crate}${suffix}`, directory = resolve(cwd, out), files = {};
  const names = new Set([base, `${base}.exe`, ...['rlib', 'rmeta', 'so', 'dylib', 'dll', 'a'].flatMap(ext =>
    [`${base}.${ext}`, `lib${base}.${ext}`])]);
  if (!existsSync(directory)) return files;
  for (const name of readdirSync(directory)) if (names.has(name)) {
    const path = join(directory, name);
    if (!lstatSync(path).isFile()) throw Error(`non-file compiler output: ${path}`);
    files[path] = sha256(readFileSync(path));
  }
  return files;
}
export function artifactHashes(artifacts) {
  const files = {};
  for (const unit of artifacts.filter(a => a.reason === 'compiler-artifact')) {
    if (!Array.isArray(unit.filenames) || !unit.filenames.length) throw Error('missing Cargo artifact file list');
    for (const path of unit.filenames) files[path] = sha256(readFileSync(path));
  }
  return files;
}
