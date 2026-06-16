/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parse the ISO 10303-21 HEADER section of a STEP/IFC file into the structured
 * {@link IfcSourceHeader} the exporter uses to round-trip header fidelity.
 *
 * This is deliberately a small, self-contained, quote-aware reader rather than
 * a reuse of the generic STEP value parser: `FILE_DESCRIPTION` items and
 * `FILE_NAME` fields routinely contain commas and parentheses inside quoted
 * strings (e.g. `'CoordinateReference [..., ProjectSite: Origin]'`), which a
 * splitter that ignores quote state would mis-split.
 */

import { safeUtf8Decode } from '@ifc-lite/data';
import type { IfcSourceHeader } from '@ifc-lite/data';

/** Headers are tiny; cap the decode so a huge file's body is never scanned. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Split STEP record arguments at top-level commas, respecting paren/bracket
 * nesting and single-quoted strings (with `''` escapes). Returns the raw,
 * still-escaped argument substrings (trimmed).
 */
function splitTopLevel(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0 || args.length > 0) {
    args.push(current.trim());
  }
  return args;
}

/** Reverse the STEP string escapes this codebase emits (`''` and `\\`). */
function unescapeStepString(str: string): string {
  return str.replace(/''/g, "'").replace(/\\\\/g, '\\');
}

/**
 * Decode a single STEP argument to a string, or `undefined` for `$`
 * (unset) / `*` (derived) / empty.
 */
function decodeOptString(arg: string): string | undefined {
  const t = arg.trim();
  if (t === '' || t === '$' || t === '*') return undefined;
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return unescapeStepString(t.slice(1, -1));
  }
  return t;
}

/**
 * Decode a STEP list argument (`('a','b',...)`) into a string array. `$` /
 * empty yield `[]`. List entries that are unset are dropped.
 */
function decodeStringList(arg: string): string[] {
  const t = arg.trim();
  if (t === '' || t === '$' || t === '*') return [];
  if (!t.startsWith('(') || !t.endsWith(')')) {
    // Tolerate a bare single value where a list was expected.
    const single = decodeOptString(t);
    return single === undefined ? [] : [single];
  }
  return splitTopLevel(t.slice(1, -1))
    .map(decodeOptString)
    .filter((v): v is string => v !== undefined);
}

/**
 * Extract the argument substring inside the parentheses of `KEYWORD( ... )`,
 * starting the search at `fromIndex`. Quote- and nesting-aware so a quoted
 * `)` never closes the record early. Returns `null` if not found.
 */
function extractRecordArgs(text: string, keyword: string, fromIndex = 0): string | null {
  const upper = text.toUpperCase();
  const at = upper.indexOf(keyword, fromIndex);
  if (at < 0) return null;
  let i = at + keyword.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '(') return null;
  const start = i;
  let depth = 0;
  let inString = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") i++;
        else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/**
 * Parse the HEADER section of a STEP/IFC buffer into {@link IfcSourceHeader}.
 * Returns `undefined` when no recognisable header records are present (e.g.
 * non-STEP input). Cheap: only the first {@link MAX_HEADER_BYTES} are decoded,
 * truncated at the first `ENDSEC` so the DATA section is never scanned.
 */
export function parseSourceHeader(buffer: Uint8Array): IfcSourceHeader | undefined {
  const cap = Math.min(buffer.length, MAX_HEADER_BYTES);
  let text = safeUtf8Decode(buffer, 0, cap);
  const endSec = text.toUpperCase().indexOf('ENDSEC');
  if (endSec >= 0) text = text.slice(0, endSec);

  const descRecord = extractRecordArgs(text, 'FILE_DESCRIPTION');
  const nameRecord = extractRecordArgs(text, 'FILE_NAME');
  const schemaRecord = extractRecordArgs(text, 'FILE_SCHEMA');

  if (descRecord === null && nameRecord === null && schemaRecord === null) {
    return undefined;
  }

  // FILE_DESCRIPTION( (<items>), <implementation_level> )
  let description: string[] = [];
  let implementationLevel = '2;1';
  if (descRecord !== null) {
    const parts = splitTopLevel(descRecord);
    if (parts.length >= 1) description = decodeStringList(parts[0]);
    if (parts.length >= 2) implementationLevel = decodeOptString(parts[1]) ?? '2;1';
  }

  // FILE_NAME( name, time_stamp, (author), (organization),
  //            preprocessor_version, originating_system, authorization )
  let name: string | undefined;
  let timeStamp: string | undefined;
  let author: string[] = [];
  let organization: string[] = [];
  let preprocessorVersion: string | undefined;
  let originatingSystem: string | undefined;
  let authorization: string | undefined;
  if (nameRecord !== null) {
    const parts = splitTopLevel(nameRecord);
    name = decodeOptString(parts[0] ?? '');
    timeStamp = decodeOptString(parts[1] ?? '');
    author = decodeStringList(parts[2] ?? '');
    organization = decodeStringList(parts[3] ?? '');
    preprocessorVersion = decodeOptString(parts[4] ?? '');
    originatingSystem = decodeOptString(parts[5] ?? '');
    authorization = decodeOptString(parts[6] ?? '');
  }

  // FILE_SCHEMA( (<identifier>, ...) )
  const schemaIdentifiers = schemaRecord !== null ? decodeStringList(schemaRecord) : [];

  return {
    description,
    implementationLevel,
    name,
    timeStamp,
    author,
    organization,
    preprocessorVersion,
    originatingSystem,
    authorization,
    schemaIdentifiers,
  };
}
