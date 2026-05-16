/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flavor schema validation. Mirrors the manifest validator pattern —
 * hand-rolled, dependency-free, structured errors with stable codes.
 *
 * Spec: docs/architecture/ai-customization/05-flavors-and-sharing.md §1.
 */

import type { Flavor, FlavorExtension } from './types.js';
import type { ValidationError, ValidationResult } from '../types.js';

const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_SOURCES: ReadonlySet<string> = new Set(['local', 'registry', 'url']);

export function validateFlavor(input: unknown): ValidationResult<Flavor> {
  const errors: ValidationError[] = [];

  if (!isPlainObject(input)) {
    return fail('', 'type_mismatch', 'Flavor must be a JSON object.');
  }
  const obj = input;

  if (obj.schemaVersion !== 1) {
    errors.push({
      path: 'schemaVersion',
      code: 'invalid_manifest_version',
      message: `Unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}.`,
      hint: 'This loader supports schemaVersion 1.',
    });
  }

  requireStringField(errors, obj, 'id', ID_RE, 'invalid_id');
  requireStringField(errors, obj, 'name');
  optionalStringField(errors, obj, 'description');
  requireStringField(errors, obj, 'createdAt', ISO_DATE_RE);
  requireStringField(errors, obj, 'updatedAt', ISO_DATE_RE);

  validateExtensions(errors, obj.extensions);
  validateArray(errors, obj.lenses, 'lenses');
  validateArray(errors, obj.savedQueries, 'savedQueries');
  validateArray(errors, obj.keybindings, 'keybindings');

  if (obj.layout !== undefined && !isPlainObject(obj.layout)) {
    errors.push({ path: 'layout', code: 'type_mismatch', message: 'layout must be an object.' });
  }
  if (obj.settings !== undefined && !isPlainObject(obj.settings)) {
    errors.push({ path: 'settings', code: 'type_mismatch', message: 'settings must be an object.' });
  }
  if (obj.promptOverlay !== undefined) {
    if (!isPlainObject(obj.promptOverlay)) {
      errors.push({
        path: 'promptOverlay',
        code: 'type_mismatch',
        message: 'promptOverlay must be an object.',
      });
    } else if (typeof obj.promptOverlay.content !== 'string') {
      errors.push({
        path: 'promptOverlay.content',
        code: 'type_mismatch',
        message: 'promptOverlay.content must be a string.',
      });
    }
  }
  if (obj.author !== undefined && !isPlainObject(obj.author)) {
    errors.push({ path: 'author', code: 'type_mismatch', message: 'author must be an object.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: obj as unknown as Flavor };
}

function validateExtensions(errors: ValidationError[], raw: unknown): void {
  if (!Array.isArray(raw)) {
    errors.push({
      path: 'extensions',
      code: 'required',
      message: 'extensions must be an array.',
    });
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const path = `extensions[${i}]`;
    if (!isPlainObject(item)) {
      errors.push({ path, code: 'type_mismatch', message: 'Each entry must be an object.' });
      continue;
    }
    const ext = item as Partial<FlavorExtension>;
    if (typeof ext.id !== 'string' || !ID_RE.test(ext.id)) {
      errors.push({ path: `${path}.id`, code: 'invalid_id', message: 'invalid extension id.' });
    }
    if (typeof ext.version !== 'string' || !SEMVER_RE.test(ext.version)) {
      errors.push({ path: `${path}.version`, code: 'invalid_semver', message: 'version must be SemVer.' });
    }
    if (typeof ext.bundleHash !== 'string' || !/^[0-9a-f]{64}$/i.test(ext.bundleHash)) {
      errors.push({ path: `${path}.bundleHash`, code: 'invalid_format', message: 'bundleHash must be 64 hex chars.' });
    }
    if (!Array.isArray(ext.grantedCapabilities)) {
      errors.push({ path: `${path}.grantedCapabilities`, code: 'required', message: 'grantedCapabilities must be an array of strings.' });
    } else if (ext.grantedCapabilities.some((c) => typeof c !== 'string')) {
      errors.push({ path: `${path}.grantedCapabilities`, code: 'type_mismatch', message: 'grantedCapabilities entries must be strings.' });
    }
    if (typeof ext.enabled !== 'boolean') {
      errors.push({ path: `${path}.enabled`, code: 'type_mismatch', message: 'enabled must be a boolean.' });
    }
    if (typeof ext.source !== 'string' || !ALLOWED_SOURCES.has(ext.source)) {
      errors.push({ path: `${path}.source`, code: 'invalid_value', message: `source must be one of: ${[...ALLOWED_SOURCES].join(', ')}.` });
    }
  }
}

function requireStringField(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  field: string,
  re?: RegExp,
  reCode: ValidationError['code'] = 'invalid_format',
): void {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    errors.push({ path: field, code: 'required', message: `${field} is required and must be a non-empty string.` });
    return;
  }
  if (re && !re.test(v)) {
    errors.push({ path: field, code: reCode, message: `${field} "${v}" did not match expected format.` });
  }
}

function optionalStringField(errors: ValidationError[], obj: Record<string, unknown>, field: string): void {
  if (obj[field] !== undefined && typeof obj[field] !== 'string') {
    errors.push({ path: field, code: 'type_mismatch', message: `${field} must be a string if present.` });
  }
}

function validateArray(errors: ValidationError[], raw: unknown, path: string): void {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push({ path, code: 'type_mismatch', message: `${path} must be an array.` });
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(
  path: string,
  code: ValidationError['code'],
  message: string,
): ValidationResult<never> {
  return { ok: false, errors: [{ path, code, message }] };
}
