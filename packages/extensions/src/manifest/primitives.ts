/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Primitive helpers used across the manifest validator. Kept dependency-
 * free so they can be reused in the future Phase 2 dry-run validation
 * pipeline without dragging the rest of the manifest module in.
 */

import type {
  ValidationError,
  ValidationErrorCode,
  ValidationResult,
} from '../types.js';

export class ValidationContext {
  errors: ValidationError[] = [];

  add(path: string, code: ValidationErrorCode, message: string, hint?: string): void {
    this.errors.push({ path, code, message, hint });
  }

  result<T>(): ValidationResult<T> {
    if (this.errors.length === 0) {
      throw new Error('ValidationContext.result() called with no errors and no value.');
    }
    return { ok: false, errors: this.errors };
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function requireString(
  ctx: ValidationContext,
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!(field in obj)) {
    ctx.add(field, 'required', `Missing required field "${field}".`);
    return undefined;
  }
  const v = obj[field];
  if (typeof v !== 'string') {
    ctx.add(field, 'type_mismatch', `Field "${field}" must be a string.`);
    return undefined;
  }
  if (v.trim().length === 0) {
    ctx.add(field, 'invalid_value', `Field "${field}" must not be empty.`);
    return undefined;
  }
  return v;
}

export function optionalString(
  ctx: ValidationContext,
  obj: Record<string, unknown>,
  field: string,
): void {
  if (!(field in obj)) return;
  const v = obj[field];
  if (typeof v !== 'string') {
    ctx.add(field, 'type_mismatch', `Field "${field}" must be a string.`);
  }
}

export function requireStringInObj(
  ctx: ValidationContext,
  item: unknown,
  path: string,
  field: string,
): void {
  if (!isPlainObject(item)) return;
  const obj = item as Record<string, unknown>;
  if (!(field in obj)) {
    ctx.add(`${path}.${field}`, 'required', `Missing required field "${field}".`);
    return;
  }
  if (typeof obj[field] !== 'string' || (obj[field] as string).trim().length === 0) {
    ctx.add(`${path}.${field}`, 'type_mismatch',
      `Field "${field}" must be a non-empty string.`);
  }
}

export function validateArray(
  ctx: ValidationContext,
  raw: unknown,
  path: string,
  itemValidator: (item: unknown, path: string) => void,
): void {
  if (!Array.isArray(raw)) {
    ctx.add(path, 'type_mismatch', `${path} must be an array.`);
    return;
  }
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      ctx.add(p, 'type_mismatch', `${p} must be an object.`);
      continue;
    }
    itemValidator(item, p);
  }
}
