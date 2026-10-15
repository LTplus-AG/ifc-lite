/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function run(command, args, cwd) {
  let executable = command;
  let argv = args;
  if (process.platform === 'win32' && (command === 'npm' || command === 'pnpm')) {
    const cli = command === 'npm' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : process.env.npm_execpath;
    if (!cli || !existsSync(cli)) throw new Error('Run pnpm test:packed with a Node/npm installation');
    if (/\.(c?js|mjs)$/i.test(cli)) { executable = process.execPath; argv = [cli, ...args]; }
    else if (/\.exe$/i.test(cli)) executable = cli;
    else throw new Error(`No direct executable entry point for ${command}`);
  }
  const result = spawnSync(executable, argv,
    { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(
    `${command} failed (${result.status}): ${result.error?.message ?? `${result.stderr}\n${result.stdout}`}`, { cause: result.error });
  return result.stdout;
}

export function workspaceClosure(root, seeds) {
  const packages = new Map();
  for (const dir of readdirSync(join(root, 'packages')).sort()) {
    const path = join(root, 'packages', dir);
    if (!existsSync(join(path, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    packages.set(manifest.name, { path, manifest });
  }
  const selected = new Map();
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    if (selected.has(name)) continue;
    const pkg = packages.get(name);
    if (!pkg || pkg.manifest.private) throw new Error(`No published workspace package for ${name}`);
    selected.set(name, pkg);
    const dependencies = { ...pkg.manifest.dependencies, ...pkg.manifest.optionalDependencies, ...pkg.manifest.peerDependencies };
    for (const dependency of Object.keys(dependencies)) {
      if (packages.has(dependency)) queue.push(dependency);
      else if (dependencies[dependency].startsWith('workspace:')) throw new Error(`Missing workspace dependency ${dependency}`);
    }
  }
  return [...selected.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function* exportTargets(value) {
  if (typeof value === 'string') yield value;
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) yield* exportTargets(nested);
  }
}

function assertBuiltPackage(name, { path, manifest }) {
  const targets = new Set([manifest.main, manifest.module, manifest.types, manifest.typings,
    ...exportTargets(manifest.exports)].filter(target => typeof target === 'string' && !target.includes('*')));
  for (const target of targets) {
    const file = join(path, target);
    if (existsSync(file) && statSync(file).isFile()) continue;
    const remedy = name === '@ifc-lite/wasm'
      ? 'Run pnpm build:wasm (or pnpm build:wasm:fetch), then pnpm build.'
      : 'Run pnpm build before pnpm test:packed.';
    throw new Error(`Missing built entry point ${name}: ${target}. ${remedy}`);
  }
}

export function packClosure(root, destination, seeds) {
  const selected = workspaceClosure(root, seeds);
  for (const [name, pkg] of selected) assertBuiltPackage(name, pkg);
  const dependencies = {};
  const versions = {};
  for (const [name, { path, manifest }] of selected) {
    const tarball = join(destination, `${name.replaceAll('/', '-').replaceAll('@', '')}.tgz`);
    run('pnpm', ['pack', '--out', tarball], path);
    dependencies[name] = `file:${tarball}`;
    versions[name] = manifest.version;
    process.stderr.write(`[packed consumer] ${name}@${manifest.version}\n`);
  }
  return { dependencies, versions };
}
