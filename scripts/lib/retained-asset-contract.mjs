// SPDX-License-Identifier: MPL-2.0
// Packaging inventory, not a compiler attestation or a runtime loader.
import { createHash } from 'node:crypto';
import { readFile, lstat, readdir, realpath } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
export { dependencies } from './retained-loader-dependencies.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const EMSCRIPTEN_REVISION = '09f52557f0d48b65b8c724853ed8f4e8bf80e669';
// Full texts independently byte-verified against emscripten-core/emscripten
// at EMSCRIPTEN_REVISION. Keep component notices, not just SPDX summaries.
export const NOTICES = [
  ['LICENSE', '620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86'],
  ['system/lib/libc/musl/COPYRIGHT', 'f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af'],
  ['system/lib/libcxx/LICENSE.TXT', '539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b'],
  ['system/lib/libcxxabi/LICENSE.TXT', 'e2b35be49f7284a45b7baca8fc7b3ab7440e7902392b2528a457816b5bb2a15c'],
  ['system/lib/compiler-rt/LICENSE.TXT', '1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d'],
];
export async function regular(path, allowEmpty = false) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected regular file: ${path}`);
  const bytes = await readFile(path);
  if (!allowEmpty && !bytes.length) throw new Error(`Empty asset: ${path}`);
  return bytes;
}
export async function files(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Nonregular input: ${path}`);
  }
  return result;
}
export async function readWithin(root, path, allowEmpty = false) {
  const full = join(root, path);
  if (relative(await realpath(root), await realpath(full)) !== path) throw new Error(`Escaped input: ${path}`);
  return regular(full, allowEmpty);
}
export function row(path, bytes) { return { path, bytes: bytes.length, sha256: digest(bytes) }; }

/** Offline integrity gate used by the real contract/scanner before serving. */
export async function verifyRetainedAssets(root, inputs) {
  const manifest = JSON.parse((await regular(join(root, 'asset-manifest.json'))).toString());
  const inventory = JSON.parse((await regular(inputs)).toString());
  if (manifest.format !== 'ifclite-retained-browser-assets-v2' || manifest.qualified !== false ||
      manifest.buildAttestation !== false || manifest.releaseAuthorized !== false || manifest.licenceClearance !== false ||
      manifest.inputInventorySha256 !== digest(Buffer.from(JSON.stringify(inventory))) ||
      JSON.stringify(manifest.assets) !== JSON.stringify(inventory.assets) ||
      JSON.stringify(manifest.dependencies) !== JSON.stringify(inventory.dependencies) ||
      JSON.stringify(manifest.sources) !== JSON.stringify(inventory.sources)) {
    throw new Error('Invalid or mismatched staged manifest');
  }
  const expected = ['asset-manifest.json', ...inventory.assets.map(asset => asset.path)].sort();
  if (JSON.stringify(await files(root)) !== JSON.stringify(expected)) throw new Error('Unexpected or missing staged assets');
  for (const asset of inventory.assets) {
    const bytes = await readWithin(root, asset.path);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw new Error(`Tampered staged asset ${asset.path}`);
  }
  return manifest;
}
