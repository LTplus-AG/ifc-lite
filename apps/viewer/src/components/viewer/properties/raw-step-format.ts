/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display + parse helpers for the Raw STEP tab.
 *
 * The serialization layer in `@ifc-lite/export` (`serializeStepValue`)
 * is the source of truth for what gets written to disk. The helpers here
 * mirror it on the read side (display) and inverse it on the write side
 * (parse user input) so the round-trip stays predictable for anyone who
 * has seen STEP literals before.
 *
 * Conventions (mirrors the SDK / `StoreEditor` doc-comments):
 *   $ / null / empty   → JS `null`
 *   .T. / .F.          → JS `true` / `false`
 *   123  / 1.5  / 1e3  → JS `number`
 *   #42                → JS string `"#42"` (STEP exporter writes as-is)
 *   .AREA.             → JS string `".AREA."`
 *   'foo'              → JS string `'foo'` (quotes added by the serializer)
 *   (a,b,c)            → JS array, recursively
 */

import type { IfcAttributeValue } from '@ifc-lite/mutations';

/**
 * Format a parsed attribute (the shape returned by
 * `EntityExtractor.extractEntity().attributes[i]`) into a display token
 * that closely mirrors the on-disk STEP literal. The result is meant to
 * be read by humans — it's not guaranteed to round-trip through the parser
 * for typed values, but it's accurate for the common cases.
 */
export function formatRawStepValue(value: unknown): string {
  if (value === null || value === undefined) return '$';
  if (typeof value === 'boolean') return value ? '.T.' : '.F.';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '$';
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'string') {
    // The parser strips reference prefixes and decodes strings already,
    // so we re-add the conventions for display fidelity.
    if (/^#\d+$/.test(value)) return value;
    if (/^\.[A-Z0-9_]+\.$/i.test(value)) return value.toUpperCase();
    if (/^[A-Z][A-Z0-9_]*$/i.test(value) && value === value.toUpperCase()) return value;
    return `'${value}'`;
  }
  if (Array.isArray(value)) {
    // Typed values come through as `[typeName, innerValue]` from the
    // parser. They render as `IFCLABEL('foo')` so they're recognisable.
    if (
      value.length === 2 &&
      typeof value[0] === 'string' &&
      /^IFC/i.test(value[0])
    ) {
      return `${(value[0] as string).toUpperCase()}(${formatRawStepValue(value[1])})`;
    }
    return `(${value.map(formatRawStepValue).join(',')})`;
  }
  // Fallback — shouldn't happen with parser output, but stay defensive.
  return String(value);
}

/**
 * Coarse classifier for "is this value safe to inline-edit?" The Raw
 * STEP row pen icon is hidden for typed values and lists; users can
 * still see them, just not edit them through the row UI.
 */
export function isInlineEditable(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'string') return true;
  // Arrays + typed values: punt to the script editor for now.
  return false;
}

/**
 * Parse a user-typed value from the inline editor into the shape
 * expected by `StoreEditor.setPositionalAttribute()`. Mirrors the
 * conventions documented at the top of this file.
 *
 * Returns either `{ value: ... }` on success or `{ error: '...' }` on
 * a clearly-invalid input. Most strings are accepted — this keeps the
 * editor permissive (so e.g. an arbitrary identifier still lands as a
 * quoted STEP string).
 */
export function parseRawStepInput(input: string): { value: IfcAttributeValue } | { error: string } {
  const trimmed = input.trim();

  if (trimmed === '' || trimmed === '$' || trimmed.toLowerCase() === 'null') {
    return { value: null };
  }
  if (trimmed === '.T.' || trimmed === '.t.') return { value: true };
  if (trimmed === '.F.' || trimmed === '.f.') return { value: false };

  // Reference: keep as-is, the serializer recognises the `#N` prefix.
  if (/^#\d+$/.test(trimmed)) return { value: trimmed };

  // Enum: normalise to upper-case dot-form.
  if (/^\.[A-Za-z0-9_]+\.$/.test(trimmed)) return { value: trimmed.toUpperCase() };

  // Number — accept both integer and real notation, including scientific.
  if (/^-?\d+$/.test(trimmed)) return { value: Number.parseInt(trimmed, 10) };
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(trimmed) || /^-?\d+\.\d*([eE][+-]?\d+)?$/.test(trimmed) || /^-?\d+[eE][+-]?\d+$/.test(trimmed)) {
    const n = Number.parseFloat(trimmed);
    if (Number.isFinite(n)) return { value: n };
  }

  // Quoted string: strip the wrapping quotes — `serializeStepValue`
  // re-adds them on export.
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return { value: trimmed.slice(1, -1).replace(/''/g, "'") };
  }

  // Lists / typed values: refuse for now. The pen icon is hidden for
  // these anyway, but if a power user pastes a list literal we should
  // flag rather than silently corrupt.
  if (trimmed.startsWith('(') || /^[A-Z][A-Z0-9_]*\(/i.test(trimmed)) {
    return { error: 'Lists and typed values must be edited from the script panel' };
  }

  // Fallback: treat as a plain string. The serializer will quote it.
  return { value: trimmed };
}
