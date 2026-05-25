/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-safe parts of the bundle loader.
 *
 * `buildBundleFromFiles` is the heart of the validation pipeline: take
 * an in-memory map of files, parse + migrate + validate the manifest,
 * and confirm every file the manifest references actually exists.
 * Pure function, no I/O, safe to bundle for the browser.
 *
 * The Node-side directory walker (`loadBundleFromDirectory`) lives in
 * `./loader-node.ts` so vite / rollup don't try to bundle `node:fs` /
 * `node:path` into the viewer's browser build.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §2.
 */

import type {
  Bundle,
  BundleFile,
  ExtensionManifest,
  ValidationError,
  ValidationResult,
} from '../types.js';
import { validateManifest } from '../manifest/index.js';
import { migrateManifest } from '../migrations/index.js';

/**
 * Build a Bundle from an in-memory file map and a manifest file entry.
 * Shared between the directory loader and the `.iflx` unpacker.
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

function decodeText(file: BundleFile): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(file.bytes);
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
