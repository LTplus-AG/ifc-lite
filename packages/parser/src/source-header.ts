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

import type { IfcSourceHeader } from '@ifc-lite/data';
import { decodeStepStringLiteral } from '@ifc-lite/encoding';

import { asSourceBytes, type IfcSourceBytes } from './source-bytes.js';

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

/**
 * Decode a STEP header string argument's inner text (outer quotes already
 * stripped) to its Unicode value.
 *
 * Both escape layers, in one scan, from the shared
 * {@link decodeStepStringLiteral}: the `''` / `\\` doublings and the
 * ISO-10303-21 backslash directives (`\X2\HHHH\X0\`, `\X\HH`, `\S\` and
 * `\Px\`) the non-ASCII header fields (author, description, ...) arrive in.
 *
 * The regex this replaced in #2486 left those directives untouched on read
 * while the writer's `\`->`\\` escaper doubled every backslash on write, so a
 * round trip turned `Tr\X2\00FC\X0\mpler` into the literal
 * `Tr\\X2\\00FC\\X0\\mpler`. Decoding to real Unicode here means the writer
 * re-emits plain UTF-8 (no backslashes to double), so the value round-trips
 * intact.
 *
 * The implementation moved into `@ifc-lite/encoding` for #2490, where
 * `@ifc-lite/data`'s `parseStepValue` had grown the SAME directive-blind regex
 * independently. Two copies of a decoder this subtle is how the second one got
 * written; see that module for why the two layers cannot be resolved by two
 * independent passes.
 */
function unescapeStepString(str: string): string {
  return decodeStepStringLiteral(str);
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
 * Index of `needle` in `text`, ignoring any occurrence inside a quoted STEP
 * string or a `/* ... *\/` comment. `needle` is matched case-insensitively;
 * callers pass it upper-case.
 *
 * A raw `indexOf` cannot tell a record keyword or a section terminator from the
 * same text sitting inside a header field's VALUE, and header values carry
 * arbitrary prose: a DESCRIPTION mentioning `ENDSEC;`, or an AUTHOR string
 * containing `FILE_NAME`, both read as structure (#3284).
 *
 * Three details, each of which cost a defect to learn:
 *
 * - Quote state toggles on every `'`. A doubled `''` -- STEP's escape for a
 *   literal apostrophe -- toggles twice and nets to a no-op, so it needs no
 *   special case.
 * - COMMENTS must be skipped too. ISO 10303-21 allows `/* ... *\/` anywhere
 *   whitespace is allowed, and an apostrophe inside one (`/* John's export *\/`)
 *   would otherwise leave the quote state inverted for the rest of the file, so
 *   every following keyword is scanned in the wrong state and NO record is
 *   found. That turns a comment into total header loss.
 * - The scan runs over `text` directly and compares per character. Uppercasing
 *   the haystack first is not safe: `'ß'.toUpperCase()` is `'SS'`, so a single
 *   German header value shifts every later index by one and the caller's
 *   `text[at + keyword.length]` lands in the wrong place.
 */
function indexOfOutsideQuotes(text: string, needle: string, fromIndex = 0): number {
  const last = text.length - needle.length;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      // An unterminated comment swallows the rest, which is what a reader does.
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (i >= fromIndex && i <= last) {
      let hit = true;
      for (let k = 0; k < needle.length; k++) {
        if (text[i + k].toUpperCase() !== needle[k]) { hit = false; break; }
      }
      if (hit) return i;
    }
  }
  return -1;
}

/**
 * Extract the argument substring inside the parentheses of `KEYWORD( ... )`,
 * starting the search at `fromIndex`. Quote- and nesting-aware so a quoted
 * `)` never closes the record early. Returns `null` if not found.
 */
function extractRecordArgs(text: string, keyword: string, fromIndex = 0): string | null {
  const at = indexOfOutsideQuotes(text, keyword, fromIndex);
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
export function parseSourceHeader(
  buffer: Uint8Array | IfcSourceBytes,
): IfcSourceHeader | undefined {
  const src = asSourceBytes(buffer);
  const cap = Math.min(src.byteLength, MAX_HEADER_BYTES);
  let text = src.decodeUtf8(0, cap);
  const endSec = indexOfOutsideQuotes(text, 'ENDSEC');
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
