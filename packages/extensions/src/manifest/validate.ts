/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manifest top-level validator.
 *
 * Walks the manifest in three passes:
 *
 *   1. Top-level field shape (required fields, types).
 *   2. Sub-structures (engines, capabilities, activation, entry, contributes,
 *      tests, l10n).
 *   3. Cross-references (commands referenced from contributions exist).
 *
 * The output is a `ValidationResult<ExtensionManifest>` with stable error
 * codes per `02-security.md` / `01-extension-model.md`.
 *
 * Spec: docs/architecture/ai-customization/01-extension-model.md §1.
 */

import { parseCapability } from '../capability/parse.js';
import type {
  ActivationEvent,
  ExtensionManifest,
  ManifestEntry,
  ValidationResult,
} from '../types.js';
import { validateContributions } from './contributions.js';
import { crossReferenceCommands } from './cross-ref.js';
import {
  ValidationContext,
  isPlainObject,
  optionalString,
  requireString,
} from './primitives.js';

// Lowercase-only. The validator message and the RFC's reverse-DNS
// guidance both promise lowercase canonical IDs; the prior `/i` flag
// silently accepted uppercase, breaking the canonical-id guarantee.
const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Permissive engine-range matcher (operators + numbers). The host loader
// performs the actual SemVer-range comparison.
const ENGINE_RANGE_RE = /^[\s\d.x*~^<>=|&-]+$/;

const ALLOWED_TOPLEVEL_FIELDS = new Set([
  'manifestVersion',
  'id',
  'name',
  'description',
  'version',
  'author',
  'license',
  'engines',
  'capabilities',
  'activation',
  'contributes',
  'entry',
  'tests',
  'l10n',
  'readme',
]);

export function validateManifest(input: unknown): ValidationResult<ExtensionManifest> {
  const ctx = new ValidationContext();

  if (!isPlainObject(input)) {
    ctx.add('', 'type_mismatch', 'Manifest must be a JSON object.');
    return ctx.result<ExtensionManifest>();
  }
  const obj = input;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOPLEVEL_FIELDS.has(key)) {
      ctx.add(key, 'unknown_field', `Unknown top-level field "${key}".`,
        'Remove it or check the spelling against the manifest schema.');
    }
  }

  validateManifestVersion(ctx, obj);
  validateId(ctx, obj);
  requireString(ctx, obj, 'name');
  requireString(ctx, obj, 'description');
  validateVersion(ctx, obj);
  if (obj.author !== undefined) validateAuthor(ctx, obj.author, 'author');
  if (obj.license !== undefined) optionalString(ctx, obj, 'license');
  validateEngines(ctx, obj.engines, 'engines');
  validateCapabilities(ctx, obj.capabilities, 'capabilities');
  validateActivation(ctx, obj.activation, 'activation');
  const entry = validateEntry(ctx, obj.entry, 'entry');
  if (obj.contributes !== undefined) {
    validateContributions(ctx, obj.contributes, 'contributes');
  }
  if (obj.tests !== undefined) validateTests(ctx, obj.tests, 'tests');
  if (obj.l10n !== undefined) validateL10n(ctx, obj.l10n, 'l10n');
  if (obj.readme !== undefined) optionalString(ctx, obj, 'readme');

  if (ctx.errors.length === 0) {
    crossReferenceCommands(ctx, obj as Record<string, unknown>, entry);
  }

  if (ctx.errors.length > 0) return ctx.result<ExtensionManifest>();
  return { ok: true, value: obj as unknown as ExtensionManifest };
}

function validateManifestVersion(ctx: ValidationContext, obj: Record<string, unknown>): void {
  if (!('manifestVersion' in obj)) {
    ctx.add('manifestVersion', 'required', 'Manifest is missing "manifestVersion".',
      'Set manifestVersion to 1 for the v1 schema.');
    return;
  }
  if (obj.manifestVersion !== 1) {
    ctx.add('manifestVersion', 'invalid_manifest_version',
      `Unsupported manifestVersion ${JSON.stringify(obj.manifestVersion)}.`,
      'This loader supports manifestVersion 1.');
  }
}

function validateId(ctx: ValidationContext, obj: Record<string, unknown>): void {
  const id = requireString(ctx, obj, 'id');
  if (id !== undefined && !ID_RE.test(id)) {
    ctx.add('id', 'invalid_id',
      `id "${id}" is not a valid identifier.`,
      'Use reverse-DNS lowercase identifiers (e.g. "com.example.fire-rating").');
  }
}

function validateVersion(ctx: ValidationContext, obj: Record<string, unknown>): void {
  const version = requireString(ctx, obj, 'version');
  if (version !== undefined && !SEMVER_RE.test(version)) {
    ctx.add('version', 'invalid_semver',
      `version "${version}" is not a valid SemVer string.`,
      'Use MAJOR.MINOR.PATCH (e.g. "1.0.0").');
  }
}

function validateAuthor(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!isPlainObject(raw)) {
    ctx.add(path, 'type_mismatch', 'author must be an object.');
    return;
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    ctx.add(`${path}.name`, 'required', 'author.name is required.');
  }
  if ('url' in raw && typeof raw.url !== 'string') {
    ctx.add(`${path}.url`, 'type_mismatch', 'author.url must be a string.');
  }
  if ('email' in raw && typeof raw.email !== 'string') {
    ctx.add(`${path}.email`, 'type_mismatch', 'author.email must be a string.');
  }
}

function validateEngines(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!isPlainObject(raw)) {
    ctx.add(path, 'required',
      'engines is required and must be an object containing "ifcLiteSdk".');
    return;
  }
  const range = raw.ifcLiteSdk;
  if (typeof range !== 'string' || range.trim().length === 0) {
    ctx.add(`${path}.ifcLiteSdk`, 'required',
      'engines.ifcLiteSdk is required and must be a SemVer range string.');
    return;
  }
  if (!ENGINE_RANGE_RE.test(range)) {
    ctx.add(`${path}.ifcLiteSdk`, 'invalid_engine_range',
      `engines.ifcLiteSdk "${range}" does not look like a SemVer range.`,
      'Example: ">=2.4.0 <3.0.0" or "^2.4.0".');
  }
}

function validateCapabilities(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!Array.isArray(raw)) {
    ctx.add(path, 'required', 'capabilities must be an array of strings.');
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string') {
      ctx.add(`${path}[${i}]`, 'type_mismatch', 'Each capability must be a string.');
      continue;
    }
    const parsed = parseCapability(item);
    if (!parsed.ok) {
      for (const err of parsed.errors) {
        ctx.add(`${path}[${i}]`, err.code, err.message, err.hint);
      }
    }
  }
}

function validateActivation(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!Array.isArray(raw)) {
    ctx.add(path, 'required', 'activation must be an array of event strings.',
      'Example: ["onStartup", "onCommand:ext.foo.bar"].');
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const v = raw[i];
    if (typeof v !== 'string') {
      ctx.add(`${path}[${i}]`, 'type_mismatch', 'Activation event must be a string.');
      continue;
    }
    if (!isActivationEvent(v)) {
      ctx.add(`${path}[${i}]`, 'invalid_activation',
        `Unknown activation event "${v}".`,
        'Allowed forms: onStartup, onModelLoad, onCommand:<id>, onLens:<id>, onExporter:<id>, onIdsValidator:<id>, onSchema:<v>, onSlot:<id>.');
    }
  }
}

function isActivationEvent(v: string): v is ActivationEvent {
  if (v === 'onStartup' || v === 'onModelLoad') return true;
  const prefixes = ['onCommand:', 'onLens:', 'onExporter:', 'onIdsValidator:', 'onSchema:', 'onSlot:'];
  return prefixes.some((p) => v.startsWith(p) && v.length > p.length);
}

function validateEntry(
  ctx: ValidationContext,
  raw: unknown,
  path: string,
): ManifestEntry | undefined {
  if (!isPlainObject(raw)) {
    ctx.add(path, 'required', 'entry is required and must be an object.');
    return undefined;
  }
  for (const field of ['activate', 'deactivate']) {
    if (field in raw && raw[field] !== undefined && typeof raw[field] !== 'string') {
      ctx.add(`${path}.${field}`, 'type_mismatch',
        `entry.${field} must be a relative path string.`);
    }
  }
  for (const field of ['commands', 'triggers']) {
    if (!(field in raw) || raw[field] === undefined) continue;
    const map = raw[field];
    if (!isPlainObject(map)) {
      ctx.add(`${path}.${field}`, 'type_mismatch',
        `entry.${field} must be a map of id → relative path.`);
      continue;
    }
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== 'string') {
        ctx.add(`${path}.${field}.${k}`, 'type_mismatch',
          `entry.${field}.${k} must be a string.`);
      }
    }
  }
  return raw as unknown as ManifestEntry;
}

function validateTests(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!Array.isArray(raw)) {
    ctx.add(path, 'type_mismatch', 'tests must be an array.');
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      ctx.add(p, 'type_mismatch', 'each test entry must be an object.');
      continue;
    }
    for (const field of ['name', 'command', 'fixture'] as const) {
      if (typeof item[field] !== 'string' || (item[field] as string).trim().length === 0) {
        ctx.add(`${p}.${field}`, 'required',
          `Field "${field}" must be a non-empty string.`);
      }
    }
    if (!isPlainObject(item.expect)) {
      ctx.add(`${p}.expect`, 'required', 'test.expect is required.');
    }
  }
}

function validateL10n(ctx: ValidationContext, raw: unknown, path: string): void {
  if (!isPlainObject(raw)) {
    ctx.add(path, 'type_mismatch', 'l10n must be an object.');
    return;
  }
  for (const [locale, entries] of Object.entries(raw)) {
    if (!isPlainObject(entries)) {
      ctx.add(`${path}.${locale}`, 'type_mismatch',
        'Each l10n locale must be an object of key → string.');
      continue;
    }
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== 'string') {
        ctx.add(`${path}.${locale}.${k}`, 'type_mismatch',
          'l10n entries must be strings.');
      }
    }
  }
}
