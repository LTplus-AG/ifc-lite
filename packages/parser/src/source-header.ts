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

import type { IfcSourceHeader, IfcStoreBase } from '@ifc-lite/data';
import { decodeStepStringLiteral } from '@ifc-lite/encoding';

import { asSourceBytes, type IfcSourceBytes } from './source-bytes.js';

import { matchesKeywordAt, StepTextScan } from './step-lexing.js';
/** Headers are tiny; cap the decode so a huge file's body is never scanned. */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * Split STEP record arguments at top-level commas, respecting paren/bracket
 * nesting, single-quoted strings (with `''` escapes) and comments. Returns the
 * raw, still-escaped argument substrings (trimmed).
 *
 * A comment is dropped rather than copied through: it is not part of the
 * argument's value, and its commas are not separators.
 */
function splitTopLevel(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  const scan = new StepTextScan(inner);
  for (let i = 0; i < inner.length; i++) {
    const skip = scan.skipLexicalAt(i);
    if (skip >= 0) {
      // A literal is part of the argument's text; a comment is not.
      if (inner[i] === "'") current += inner.slice(i, skip);
      i = skip - 1;
      continue;
    }
    const ch = inner[i];
    if (ch === '(' || ch === '[') {
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
 * Index of `keyword` occurring as a RECORD, outside any string or comment, or
 * -1.
 *
 * A plain `indexOf` is not enough here and the reason is the same one #3278 is
 * about, one level down: header FREE TEXT is not a declaration. STEP strings
 * are single-quoted with `''` as the escape, and a `FILE_DESCRIPTION` item is
 * free to contain the literal text `FILE_SCHEMA(('IFC2X3'))` -- an exporter
 * stamping its own header into a description, a file round-tripped through a
 * tool that quotes what it read. `indexOf` would take that quoted copy as the
 * declaration and answer IFC2X3 for an IFC4X3 file. The same applies to
 * `ENDSEC`: a quoted one would truncate the header before the real
 * `FILE_SCHEMA` record, losing the declaration entirely.
 */
function indexOfRecord(text: string, keyword: string): number {
  const scan = new StepTextScan(text);
  for (let i = 0; i < text.length; i++) {
    const skip = scan.skipLexicalAt(i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (matchesKeywordAt(text, i, keyword)) return i;
  }
  return -1;
}

/**
 * Extract the argument substring inside the parentheses of `KEYWORD( ... )`.
 * Quote-, comment- and nesting-aware so a quoted
 * `)` never closes the record early, and so a quoted KEYWORD is never mistaken
 * for the record itself. Returns `null` if not found.
 */
function extractRecordArgs(text: string, keyword: string): string | null {
  const at = indexOfRecord(text, keyword);
  if (at < 0) return null;
  const scan = new StepTextScan(text);
  let i = scan.skipTrivia(at + keyword.length);
  if (text[i] !== '(') return null;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const skip = scan.skipLexicalAt(i);
    if (skip >= 0) { i = skip - 1; continue; }
    const ch = text[i];
    if (ch === '(') {
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
  const endSec = indexOfRecord(text, 'ENDSEC');
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

/**
 * Resolve one `FILE_SCHEMA` identifier to the schema version a store carries.
 *
 * Matched by PREFIX, longest first: the spellings that reach us in the wild
 * carry addendum/corrigendum suffixes (`IFC4X3_ADD2`, `IFC4X1`, `IFC2X3_TC1`),
 * and `IFC4X3` itself begins with `IFC4`, so the `IFC4X3` branch has to be
 * tried before the `IFC4` one. Returns `undefined` for an identifier naming no
 * schema we model, so the caller can keep looking.
 */
function schemaFromIdentifier(identifier: string): IfcStoreBase['schemaVersion'] | undefined {
  const token = identifier.trim().toUpperCase();
  if (token.startsWith('IFC5')) return 'IFC5';
  if (token.startsWith('IFC4X3')) return 'IFC4X3';
  if (token.startsWith('IFC4')) return 'IFC4';
  if (token.startsWith('IFC2X3')) return 'IFC2X3';
  return undefined;
}

/** Upper-case the ASCII letters and nothing else. See `detectSchemaVersion`. */
function asciiUpper(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : text[i];
  }
  return out;
}

/**
 * Determine which IFC schema a STEP buffer declares (issue #3278).
 *
 * The `FILE_SCHEMA` declaration is authoritative and is read from the
 * already-parsed {@link IfcSourceHeader}; free text elsewhere in the header is
 * not. That distinction is the whole point. `FILE_DESCRIPTION` and `FILE_NAME`
 * carry author, organisation, preprocessor and originating-system strings, and
 * exporters routinely stamp a schema token into their product name ("SomeApp
 * IFC4 Exporter") — which a raw substring scan of the header bytes cannot tell
 * apart from a declaration. Reading the record also reaches declarations that
 * sit past the first 2 KB: ISO 10303-21 puts `FILE_SCHEMA` *after* `FILE_NAME`,
 * and a long author or organisation list pushes it out of a small fixed window.
 *
 * Free on the hot path: {@link parseSourceHeader} already runs on every parse,
 * so nothing extra is scanned. The raw decode below now happens only for a file
 * that declares no schema at all.
 *
 * When no `FILE_SCHEMA` identifier resolves, fall back to the historical raw
 * scan of the first 2000 bytes rather than refusing, so every file that
 * resolves today keeps resolving the same way.
 */
export function detectSchemaVersion(
  buffer: Uint8Array | IfcSourceBytes,
  header: IfcSourceHeader | undefined,
): IfcStoreBase['schemaVersion'] {
  for (const identifier of header?.schemaIdentifiers ?? []) {
    const version = schemaFromIdentifier(identifier);
    if (version !== undefined) return version;
  }

  const src = asSourceBytes(buffer);
  const headerEnd = Math.min(src.byteLength, 2000);
  // ASCII-only, for the same reason `matchesKeywordAt` is. `toUpperCase()`
  // maps `ı` (dotless i) to `I`, so a FILE_DESCRIPTION mentioning `ıFC5` chose
  // IFC5 for a file that never said so. This scan is already a loose
  // last-resort substring match -- it only runs when no FILE_SCHEMA identifier
  // resolved at all -- but loose is not a reason to accept a fold 10303-21
  // does not use. Offsets are not taken from this copy, so a copy is fine here
  // where it was not in the record scan.
  const headerText = asciiUpper(src.decodeUtf8(0, headerEnd));

  if (headerText.includes('IFC5')) return 'IFC5';
  if (headerText.includes('IFC4X3')) return 'IFC4X3';
  if (headerText.includes('IFC4')) return 'IFC4';
  if (headerText.includes('IFC2X3')) return 'IFC2X3';

  return 'IFC4'; // Default fallback
}
