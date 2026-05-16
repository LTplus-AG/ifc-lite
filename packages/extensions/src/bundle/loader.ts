/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bundle layout walker.
 *
 * An extension on disk is a directory with `manifest.json` at the root,
 * source files under `src/`, optional `widgets/` and `tests/`, etc. This
 * module reads such a directory (Node fs) into an in-memory `Bundle`
 * value, validates the manifest, and confirms that every file referenced
 * by `entry.*` and `contributes.dock[*].widget` exists in the bundle.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §2.
 */

import { promises as fs } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import type {
  Bundle,
  BundleFile,
  ExtensionManifest,
  ValidationError,
  ValidationResult,
} from '../types.js';
import { validateManifest } from '../manifest/index.js';
import { migrateManifest } from '../migrations/index.js';

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json',
  '.md', '.txt', '.svg', '.css', '.html',
]);
const MAX_DIRECTORY_FILES = 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MiB per file.

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

/**
 * Build a Bundle from an in-memory file map and a manifest file entry.
 * Shared between the directory loader and the .iflx unpacker.
 */
export function buildBundleFromFiles(
  files: Map<string, BundleFile>,
  manifestFile: BundleFile,
  source: Bundle['source'],
): ValidationResult<Bundle> {
  // Parse manifest JSON.
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(decodeText(manifestFile));
  } catch (err) {
    return failOne('manifest.json', 'invalid_format',
      `manifest.json is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }

  // Migrate to current version.
  if (!isPlainRecord(manifestJson)) {
    return failOne('', 'type_mismatch', 'manifest.json must be a JSON object.');
  }
  const migrated = migrateManifest(manifestJson);
  if (!migrated.ok) return migrated;

  // Validate.
  const validated = validateManifest(migrated.value);
  if (!validated.ok) return validated;
  const manifest = validated.value;

  // Cross-reference referenced files.
  const refErrors = checkReferencedFiles(manifest, files);
  if (refErrors.length > 0) {
    return { ok: false, errors: refErrors };
  }

  return {
    ok: true,
    value: {
      manifest,
      files,
      source,
    },
  };
}

/**
 * Verify that every file path referenced by the manifest exists in the
 * bundle's file map.
 */
function checkReferencedFiles(
  manifest: ExtensionManifest,
  files: Map<string, BundleFile>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  const expect = (path: string, refPath: string) => {
    const normalised = normalise(path);
    if (!files.has(normalised)) {
      errors.push({
        path: refPath,
        code: 'invalid_reference',
        message: `Referenced file "${path}" not found in bundle.`,
      });
    }
  };

  const entry = manifest.entry;
  if (entry.activate) expect(entry.activate, 'entry.activate');
  if (entry.deactivate) expect(entry.deactivate, 'entry.deactivate');
  if (entry.commands) {
    for (const [id, p] of Object.entries(entry.commands)) {
      expect(p, `entry.commands.${id}`);
    }
  }
  if (entry.triggers) {
    for (const [id, p] of Object.entries(entry.triggers)) {
      expect(p, `entry.triggers.${id}`);
    }
  }
  for (const d of manifest.contributes?.dock ?? []) {
    expect(d.widget, `contributes.dock[].widget`);
  }
  for (const ex of manifest.contributes?.exporters ?? []) {
    expect(ex.handler, `contributes.exporters[].handler`);
  }
  for (const v of manifest.contributes?.idsValidators ?? []) {
    expect(v.handler, `contributes.idsValidators[].handler`);
  }
  for (const l of manifest.contributes?.lenses ?? []) {
    expect(l.evaluator, `contributes.lenses[].evaluator`);
  }
  return errors;
}

async function collectFiles(
  rootDir: string,
  current: string,
  out: Map<string, BundleFile>,
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const e of entries) {
    if (out.size >= MAX_DIRECTORY_FILES) {
      throw new Error(`Bundle exceeds maximum file count (${MAX_DIRECTORY_FILES}).`);
    }
    if (e.name.startsWith('.')) continue; // skip dotfiles (.DS_Store etc.)
    const full = join(current, e.name);
    if (e.isDirectory()) {
      await collectFiles(rootDir, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    const bytes = await fs.readFile(full);
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error(`File ${full} exceeds max bundle file size of ${MAX_FILE_BYTES} bytes.`);
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

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
