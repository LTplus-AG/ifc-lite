/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node-only bundle loading.
 *
 * `loadBundleFromDirectory` walks an extension directory using `node:fs`
 * and `node:path`. Kept out of the browser-safe `./loader.ts` so vite /
 * rollup don't try to externalize the node primitives into the viewer's
 * browser build (which fails the build).
 *
 * Reachable via the package's `./node` subpath export. Browser consumers
 * (viewer) never import this — they unpack `.iflx` bytes via
 * `unpackBundle` / `unpackBundleWithSignature` from the main barrel.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §2.
 */

import { promises as fs } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type {
  Bundle,
  BundleFile,
  ValidationError,
  ValidationResult,
} from '../types.js';
import { buildBundleFromFiles } from './loader.js';

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json',
  '.md', '.txt', '.svg', '.css', '.html',
]);
const MAX_DIRECTORY_FILES = 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MiB per file.
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024; // 16 MiB aggregate.

/**
 * Load a bundle from a filesystem directory. Returns a fully-validated
 * Bundle on success.
 */
export async function loadBundleFromDirectory(
  rootDir: string,
): Promise<ValidationResult<Bundle>> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(rootDir);
  } catch (err) {
    return failOne('', 'invalid_reference',
      `Bundle directory does not exist: ${rootDir}`,
      err instanceof Error ? err.message : undefined);
  }
  if (!stat.isDirectory()) {
    return failOne('', 'type_mismatch',
      `Bundle path is not a directory: ${rootDir}`);
  }

  const files = new Map<string, BundleFile>();
  try {
    await collectFiles(rootDir, rootDir, files);
  } catch (err) {
    return failOne('', 'invalid_reference',
      err instanceof Error ? err.message : 'Failed to read bundle directory.');
  }

  const manifestFile = files.get('manifest.json');
  if (!manifestFile) {
    return failOne('manifest.json', 'required',
      'Bundle is missing manifest.json at the root.');
  }

  return buildBundleFromFiles(files, manifestFile, {
    kind: 'directory',
    origin: rootDir,
  });
}

async function collectFiles(
  rootDir: string,
  current: string,
  out: Map<string, BundleFile>,
  state: { totalBytes: number } = { totalBytes: 0 },
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const e of entries) {
    if (out.size >= MAX_DIRECTORY_FILES) {
      throw new Error(`Bundle exceeds maximum file count (${MAX_DIRECTORY_FILES}).`);
    }
    if (e.name.startsWith('.')) continue; // skip dotfiles (.DS_Store etc.)
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await collectFiles(rootDir, full, out, state);
      continue;
    }
    if (!e.isFile()) continue;
    const bytes = await fs.readFile(full);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File ${full} exceeds max bundle file size of ${MAX_FILE_BYTES} bytes.`);
    }
    state.totalBytes += bytes.byteLength;
    if (state.totalBytes > MAX_BUNDLE_BYTES) {
      throw new Error(
        `Bundle aggregate size exceeds ${MAX_BUNDLE_BYTES} bytes (already ${state.totalBytes}).`,
      );
    }
    const rel = relative(rootDir, full).split(sep).join(posix.sep);
    const file: BundleFile = {
      path: rel,
      bytes: new Uint8Array(bytes),
    };
    if (isProbablyText(rel)) {
      file.text = decodeText(file);
    }
    out.set(rel, file);
  }
}

function decodeText(file: BundleFile): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(file.bytes);
}

function isProbablyText(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function failOne(
  path: string,
  code: ValidationError['code'],
  message: string,
  detail?: string,
): ValidationResult<never> {
  return {
    ok: false,
    errors: [{
      path,
      code,
      message: detail ? `${message} (${detail})` : message,
    }],
  };
}
