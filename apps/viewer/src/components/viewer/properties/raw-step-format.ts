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
import { safeUtf8Decode } from '@ifc-lite/data';

/**
 * Tokenize the inside of a STEP entity body (`,`-separated arguments)
 * with awareness of nested parens and quoted strings. Same semantics
 * as `splitTopLevelArgs` in `@ifc-lite/export` (kept inline here to
 * avoid leaking a private util across the package boundary).
 */
function splitTopLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        // STEP escapes a single quote by doubling it (`''`).
        if (text[i + 1] === "'") {
          current += text[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
    } else if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() || parts.length > 0) parts.push(current.trim());
  return parts;
}

/**
 * Read raw positional argument tokens directly from the STEP source
 * buffer for an entity. Returns `null` if the entity body can't be
 * parsed (mismatched parens, no source bytes, …).
 *
 * Each token is the verbatim on-disk literal — `#42` for refs,
 * `.AREA.` for enums, `'My Column'` for strings, `1.5` for numbers.
 * This is the most faithful representation for the "Raw STEP" view
 * and it side-steps the need to round-trip references through the
 * EntityExtractor (which strips the `#` prefix when it parses them
 * into JS numbers).
 */
export function extractRawStepTokens(
  buffer: Uint8Array,
  byteOffset: number,
  byteLength: number,
): string[] | null {
  if (byteLength <= 0) return null;
  // safeUtf8Decode handles SAB-backed source buffers (the parser
  // keeps `dataStore.source` SAB-backed for zero-copy worker sharing,
  // and Firefox/Chrome reject `TextDecoder.decode()` on SAB views).
  const text = safeUtf8Decode(buffer, byteOffset, byteOffset + byteLength);
  // Match #N=TYPE( ... ) — the trailing `;` is optional in case the
  // ref slice doesn't include it.
  const match = text.match(/^#\d+\s*=\s*[A-Z0-9_]+\(([\s\S]*)\)\s*;?\s*$/i);
  if (!match) return null;
  return splitTopLevelArgs(match[1]);
}

/**
 * Serialize an overlay attribute value to the canonical STEP token
 * form. Mirrors `serializeStepValue` in `@ifc-lite/export` for the
 * conventions the StoreEditor / setPositionalAttribute API document.
 *
 * Used to render the displayed value when a positional override
 * exists — the override is held as a JS value (number / string /
 * null / array), but the row UI needs a STEP literal to look right
 * next to the unmodified base tokens.
 */
export function serializeStepToken(value: IfcAttributeValue): string {
  if (value === null || value === undefined) return '$';
  if (typeof value === 'boolean') return value ? '.T.' : '.F.';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '$';
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Strings tagged as references / enums / wildcards pass through
    // unchanged — the StoreEditor's input convention already keeps
    // them in canonical form.
    if (trimmed === '$' || trimmed === '*') return trimmed;
    if (/^#\d+$/.test(trimmed)) return trimmed;
    if (/^\.[A-Z0-9_]+\.$/i.test(trimmed)) return trimmed.toUpperCase();
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value)) {
    return `(${value.map(serializeStepToken).join(',')})`;
  }
  return String(value);
}

/**
 * Coarse classifier for "is this token safe to inline-edit?" Lists
 * (`(...)`) and typed values (`IFCLABEL(...)`) are display-only —
 * the row UI hides the pen icon for them and tells the user to
 * reach for the script panel.
 */
export function isInlineEditableToken(token: string): boolean {
  const t = token.trim();
  if (!t) return true;
  if (t.startsWith('(')) return false;
  if (/^[A-Z][A-Z0-9_]*\(/i.test(t)) return false;
  return true;
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
