/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileHash } from './interleaved-assets.mjs';

export function bindgenVersion(lock) {
  const matches = [...lock.matchAll(/\[\[package\]\]\s+name = "wasm-bindgen"\s+version = "(\d+\.\d+\.\d+)"/g)];
  if (matches.length !== 1) throw new Error('one exact locked wasm-bindgen version required');
  return matches[0][1];
}
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 }).trim();
export async function prefetchBindgen(directories, output) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !process.env.RUNNER_TEMP || !process.env.GITHUB_PATH) throw new Error('hosted Linux x64 tool prefetch required');
  const versions = Object.values(directories).map(directory => bindgenVersion(readFileSync(join(directory, 'Cargo.lock'), 'utf8')));
  if (new Set(versions).size !== 1) throw new Error('paired wasm-bindgen versions differ');
  const version = versions[0], name = `wasm-bindgen-${version}-x86_64-unknown-linux-musl`;
  const directory = join(process.env.RUNNER_TEMP, 'sdk-wasm-bindgen');
  if (existsSync(directory)) throw new Error('new transform directory required');
  mkdirSync(directory); const archive = join(output, 'wasm-bindgen.tar.gz');
  writeFileSync(archive, Buffer.alloc(0), { flag: 'wx' });
  const url = `https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${name}.tar.gz`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
  let bytes = 0;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || !response.body || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(new URL(response.url).hostname) || new URL(response.url).protocol !== 'https:') throw new Error('official transform download refused');
    for await (const chunk of response.body) {
      bytes += chunk.byteLength; if (bytes > 64 * 1024 ** 2) throw new Error('transform archive bound');
      writeFileSync(archive, chunk, { flag: 'a' });
    }
  } finally { clearTimeout(timer); controller.abort(); }
  const entries = command('tar', ['-tzf', archive]).split('\n');
  const allowed = new Set(['', 'wasm-bindgen', 'wasm-bindgen-test-runner', 'wasm2es6js', 'README.md', 'LICENSE-APACHE', 'LICENSE-MIT']);
  const listing = command('tar', ['-tvzf', archive]).split('\n');
  const sizes = listing.map(line => /^[d-]\S*\s+\S+\s+(\d+)\s/.exec(line));
  if (sizes.some(item => !item) || sizes.reduce((sum, item) => sum + Number(item[1]), 0) > 512 * 1024 ** 2) throw new Error('transform expanded archive bound/type');
  if (!bytes || entries.length > 10 || entries.some(path => !path.startsWith(`${name}/`) || !allowed.has(path.slice(name.length + 1)))
    || listing.some(line => !/^[d-]/.test(line))) throw new Error('transform archive member/type refused');
  execFileSync('tar', ['-xzf', archive, '-C', directory, '--no-same-owner'], { timeout: 30000 });
  const toolDirectory = join(directory, name), executable = realpathSync(join(toolDirectory, 'wasm-bindgen'));
  if (command(executable, ['--version']) !== `wasm-bindgen ${version}`) throw new Error('prefetched transform version differs');
  const files = { [archive]: await fileHash(archive) };
  for (const path of entries.filter(path => !path.endsWith('/'))) {
    const file = join(directory, path); if (statSync(file).size > 256 * 1024 ** 2) throw new Error('transform member size bound');
    files[file] = await fileHash(file);
  }
  const receipt = { version, executable, toolDirectory, url, archive, archiveBytes: bytes, files,
    selection: 'wasm-pack v0.15.0 prefers exact-version global PATH tool before its cache; no transform fallback authorized' };
  writeFileSync(join(output, 'bindgen-prefetch.json'), JSON.stringify(receipt, null, 2));
  writeFileSync(process.env.GITHUB_PATH, `${toolDirectory}\n`, { flag: 'a' });
}
export async function requireBindgen(receipt, directories) {
  const executable = realpathSync(command('which', ['wasm-bindgen']));
  if (executable !== receipt.executable || command(executable, ['--version']) !== `wasm-bindgen ${receipt.version}`
    || Object.values(directories).some(directory => bindgenVersion(readFileSync(join(directory, 'Cargo.lock'), 'utf8')) !== receipt.version)) {
    throw new Error('actual PATH transform/version differs from prefetched pair');
  }
  for (const [path, hash] of Object.entries(receipt.files)) if (await fileHash(path) !== hash) throw new Error('prefetched transform bytes changed');
  return { executable, version: receipt.version, sha256: await fileHash(executable) };
}
