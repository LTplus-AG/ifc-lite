// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface RetainedEngine {
  directory: string;
  url: URL;
  sdk: unknown;
  capabilities: unknown;
  manifestSha256: string;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const required = ['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm',
  'pkg-retained/package.json', 'smlib/node/client.mjs', 'smlib/node/worker.mjs',
  'smlib/node/hooks.mjs', 'smlib/worker.mjs', 'smlib/module.mjs',
  'smlib/sweep.mjs', 'smlib/sweep-contract.mjs', 'smlib/contract.mjs', 'smlib/ifclite_smlib_browser.mjs',
  'smlib/ifclite_smlib_browser.wasm', 'LICENSES/SMLib/LICENSE',
  'LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'LICENSES/ifc-lite/LICENSE'];

export function requireRetainedNode(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 6)) throw new Error('Retained export requires Node >=20.6');
}

/** Verify the complete inventory before importing any engine code. Hashes are
 * integrity checks, not provenance or authorization to execute an untrusted SDK. */
export async function validateEngine(directory?: string): Promise<RetainedEngine> {
  requireRetainedNode();
  if (!directory) throw new Error('Retained export requires --retained-engine DIR or IFCLITE_RETAINED_ENGINE');
  const root = await realpath(resolve(directory));
  const manifestPath = join(root, 'engine-manifest.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Invalid retained engine manifest');
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest?.format !== 'ifc-lite.retained-engine/1' || !Array.isArray(manifest.assets) ||
      !/^[a-f0-9]{40}$/.test(manifest.sdk?.revision) || !Object.hasOwn(manifest, 'capabilities')) {
    throw new Error('Invalid retained engine manifest');
  }
  const paths = new Set<string>();
  for (const asset of manifest.assets) {
    if (typeof asset?.path !== 'string' || !asset.path.split('/').every((p: string) => /^[\w.-]+$/.test(p) && p !== '.' && p !== '..') ||
        paths.has(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0) {
      throw new Error('Invalid retained engine asset entry');
    }
    paths.add(asset.path);
  }
  const actual = new Set<string>();
  async function walk(prefix = ''): Promise<void> {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) actual.add(path);
      else throw new Error(`Retained engine contains a non-regular asset: ${path}`);
    }
  }
  await walk();
  actual.delete('engine-manifest.json');
  if (actual.size !== paths.size || [...actual].some(p => !paths.has(p)) || required.some(p => !paths.has(p))) {
    throw new Error('Retained engine inventory is incomplete');
  }
  for (const asset of manifest.assets) {
    const content = await readFile(join(root, asset.path));
    if (content.length !== asset.bytes || digest(content) !== asset.sha256) {
      throw new Error(`Retained engine manifest hash mismatch: ${asset.path}`);
    }
  }
  return { directory: root, url: pathToFileURL(`${root}/`), sdk: manifest.sdk,
    capabilities: manifest.capabilities, manifestSha256: digest(bytes) };
}
