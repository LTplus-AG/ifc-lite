#!/usr/bin/env tsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate per-IFC-version schema data for `@ifc-lite/data` from the
 * vendored `SchemaInfo.*.g.cs` files in `scripts/upstream/`.
 *
 * Output: TypeScript modules in `src/ifc-schema/generated/` covering
 * - entities (with parent, abstract flag, predefined types, direct attrs)
 * - propertysets (with applicable entities and per-property data type)
 * - partOf relations
 * - object→type relations (`IFCWALL → IFCWALLTYPE`)
 *
 * The audit module in `@ifc-lite/ids` consumes these via `getEntities`,
 * `getPropertySets`, `getPartOfRelations` and `getObjectTypeMap`.
 *
 * Usage:
 *   pnpm --filter @ifc-lite/data run generate:ifc-schema
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstreamDir = path.join(here, 'upstream');
const outDir = path.join(here, '..', 'src', 'ifc-schema', 'generated');

type IfcVersion = 'Ifc2x3' | 'Ifc4' | 'Ifc4x3';

interface ClassInfo {
  name: string;
  parent: string;
  abstract: boolean;
  predefinedTypes: string[];
  source: string;
  attributes: string[];
}

interface PropertyInfo {
  name: string;
  /** "single" (typed via IfcXxx), "enumeration" (named enum values), "complex", etc. */
  kind: 'single' | 'enumeration' | 'list' | 'bounded' | 'reference' | 'unknown';
  /** Datatype token for single-value properties (e.g. "IfcLabel"). */
  dataType?: string;
  /** Allowed values for enumeration properties. */
  enumeration?: string[];
}

interface PsetInfo {
  name: string;
  properties: PropertyInfo[];
  applicableEntities: string[];
}

interface PartOfRelation {
  /** Relationship name, e.g. "IFCRELAGGREGATES". */
  relation: string;
  /** Owner entity (the "container"). */
  owner: string;
  /** Member entity (the "part"). */
  member: string;
}

const HEADER =
  '/* This Source Code Form is subject to the terms of the Mozilla Public\n' +
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this\n' +
  ' * file, You can obtain one at https://mozilla.org/MPL/2.0/. */\n\n' +
  '/**\n' +
  ' * Auto-generated from `scripts/upstream/SchemaInfo.*.g.cs` (buildingSMART/\n' +
  ' * IDS-Audit-tool, MIT). Do not edit by hand — regenerate via\n' +
  ' *   pnpm --filter @ifc-lite/data run generate:ifc-schema\n' +
  ' */\n\n';

// ---------------------------------------------------------------------------
// C# parser helpers
// ---------------------------------------------------------------------------

/**
 * Token from a C# argument list: either a quoted string scalar or a
 * string-array (collected from `new[] { ... }` / `new IPropertyTypeInfo[]
 * { ... }` / `Enumerable.Empty<string>()`).
 */
type CsToken =
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: string[] };

const NEW_ARRAY_RX = /new\s*(?:[A-Za-z<>]+)?\s*\[\s*\]\s*\{/y;

/**
 * Tokenise a C# argument list. We only track the two token kinds we
 * actually care about (scalar strings and string arrays) — `ClassType.X`,
 * `Definition = "..."` initialisers and the like are skipped over without
 * being modelled. String literals inside `Definition = "..."` are
 * intentionally skipped because the brace-tracking we use to find the
 * end of an enclosing array would otherwise consume them.
 */
function tokenise(src: string): CsToken[] {
  const out: CsToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '"') {
      // Top-level scalar string.
      const value = readString(src, i);
      if (value === null) break;
      out.push({ kind: 'string', value: value.value });
      i = value.end;
      continue;
    }
    if (src.startsWith('Enumerable.Empty<string>()', i)) {
      out.push({ kind: 'array', items: [] });
      i += 'Enumerable.Empty<string>()'.length;
      continue;
    }
    NEW_ARRAY_RX.lastIndex = i;
    const arrayHead = NEW_ARRAY_RX.exec(src);
    if (arrayHead && arrayHead.index === i) {
      const openBrace = i + arrayHead[0].length - 1; // position of `{`
      const close = findMatchingBrace(src, openBrace);
      if (close === -1) break;
      const items = collectStringsFlat(src.slice(openBrace + 1, close));
      out.push({ kind: 'array', items });
      i = close + 1;
      continue;
    }
    // `Definition = "..."` initialisers and similar — skip over the next
    // matching brace block if we're at one, otherwise consume one char.
    if (ch === '{') {
      const close = findMatchingBrace(src, i);
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    i++;
  }
  return out;
}

function readString(
  src: string,
  start: number
): { value: string; end: number } | null {
  if (src.charAt(start) !== '"') return null;
  let i = start + 1;
  let value = '';
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '\\' && i + 1 < src.length) {
      const next = src.charAt(i + 1);
      if (next === '"') value += '"';
      else if (next === '\\') value += '\\';
      else if (next === 'n') value += '\n';
      else if (next === 't') value += '\t';
      else if (next === 'r') value += '\r';
      else value += next;
      i += 2;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return null;
}

/**
 * Collect every top-level string literal from `slice`, ignoring strings
 * that appear inside nested `{ ... }` initialisers (so per-property
 * `Definition = "..."` text doesn't leak into the entity list).
 */
function collectStringsFlat(slice: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < slice.length) {
    const ch = slice.charAt(i);
    if (ch === '"') {
      const v = readString(slice, i);
      if (!v) break;
      out.push(v.value);
      i = v.end;
      continue;
    }
    if (ch === '{') {
      const close = findMatchingBrace(slice, i);
      i = close === -1 ? slice.length : close + 1;
      continue;
    }
    if (ch === '(') {
      // Nested call (e.g. `new SingleValuePropertyType("X", "Y") { ... }`)
      // — skip its arguments wholesale.
      const close = findMatchingParen(slice, i);
      i = close === -1 ? slice.length : close + 1;
      continue;
    }
    i++;
  }
  return out;
}

function findMatchingParen(src: string, openIdx: number): number {
  if (src.charAt(openIdx) !== '(') return -1;
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src.charAt(i);
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '"') {
      const v = readString(src, i);
      i = v ? v.end : i + 1;
      continue;
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

// ---------------------------------------------------------------------------
// SchemaInfo.Schemas.g.cs parser
// ---------------------------------------------------------------------------

function parseSchemas(): Record<IfcVersion, ClassInfo[]> {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.Schemas.g.cs'),
    'utf8'
  );
  const versions: Record<IfcVersion, ClassInfo[]> = {
    Ifc2x3: [],
    Ifc4: [],
    Ifc4x3: [],
  };
  const sections: { version: IfcVersion; from: number; to: number }[] = [];
  for (const v of ['Ifc2x3', 'Ifc4', 'Ifc4x3'] as IfcVersion[]) {
    const startMarker = `GetClassesIFC${v.slice(3)}()`;
    const start = src.indexOf(startMarker);
    if (start === -1) {
      throw new Error(`Could not find ${startMarker} in Schemas.g.cs`);
    }
    sections.push({ version: v, from: start, to: src.length });
  }
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (i + 1 < sections.length) s.to = sections[i + 1].from;
  }
  for (const sec of sections) {
    const slice = src.slice(sec.from, sec.to);
    versions[sec.version] = parseClassInfoBlock(slice);
  }
  return versions;
}

function parseClassInfoBlock(src: string): ClassInfo[] {
  const out: ClassInfo[] = [];
  // Parse each `new ClassInfo(...)` invocation by walking parens. Each
  // line in the upstream is on a single line, so split on `new ClassInfo(`
  // and read until the matching close paren.
  const marker = 'new ClassInfo(';
  let cursor = src.indexOf(marker);
  while (cursor !== -1) {
    const argStart = cursor + marker.length;
    let depth = 1;
    let i = argStart;
    while (i < src.length && depth > 0) {
      const ch = src.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') {
        // Skip string literals (might contain unmatched parens, though
        // in this dataset they don't).
        i++;
        while (i < src.length && src.charAt(i) !== '"') {
          if (src.charAt(i) === '\\') i++;
          i++;
        }
      }
      i++;
    }
    if (depth !== 0) break;
    const inner = src.slice(argStart, i - 1);
    out.push(parseClassInfoArgs(inner));
    cursor = src.indexOf(marker, i);
  }
  return out;
}

function parseClassInfoArgs(args: string): ClassInfo {
  // Args order: name, parent, ClassType.X, predefinedTypes, source, attrs.
  // Tokens we extract: [string(name), string(parent), array(predef),
  // string(source), array(attrs)] — `ClassType.X` is consumed by the
  // tokeniser as nothing.
  const tokens = tokenise(args);
  const name = tokens.find((t) => t.kind === 'string')?.value ?? '';
  // Strip `name` from the token stream so subsequent `string` lookups
  // don't grab the same one.
  let i = tokens.findIndex((t) => t.kind === 'string') + 1;
  const parent = nextString(tokens, i);
  i = parent.next;
  const predef = nextArray(tokens, i);
  i = predef.next;
  const source = nextString(tokens, i);
  i = source.next;
  const attrs = nextArray(tokens, i);

  const isAbstract = /ClassType\.Abstract\b/.test(args);

  return {
    name,
    parent: parent.value,
    abstract: isAbstract,
    predefinedTypes: predef.value,
    source: source.value,
    attributes: attrs.value.filter((a) => a !== ''),
  };
}

function nextString(
  tokens: CsToken[],
  start: number
): { value: string; next: number } {
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j].kind === 'string') {
      return { value: (tokens[j] as { value: string }).value, next: j + 1 };
    }
  }
  return { value: '', next: tokens.length };
}

function nextArray(
  tokens: CsToken[],
  start: number
): { value: string[]; next: number } {
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j].kind === 'array') {
      return {
        value: (tokens[j] as { items: string[] }).items,
        next: j + 1,
      };
    }
  }
  return { value: [], next: tokens.length };
}

// ---------------------------------------------------------------------------
// SchemaInfo.Properties.g.cs parser
// ---------------------------------------------------------------------------

function parseProperties(): Record<IfcVersion, PsetInfo[]> {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.Properties.g.cs'),
    'utf8'
  );
  const out: Record<IfcVersion, PsetInfo[]> = {
    Ifc2x3: [],
    Ifc4: [],
    Ifc4x3: [],
  };
  for (const v of ['Ifc2x3', 'Ifc4', 'Ifc4x3'] as IfcVersion[]) {
    const startMarker = `GetPropertiesIFC${v.slice(3)}`;
    const startIdx = src.indexOf(startMarker);
    if (startIdx === -1) continue;
    let endIdx: number;
    if (v === 'Ifc2x3') endIdx = src.indexOf('GetPropertiesIFC4', startIdx + 5);
    else if (v === 'Ifc4') endIdx = src.indexOf('GetPropertiesIFC4x3', startIdx + 5);
    else endIdx = src.length;
    if (endIdx === -1) endIdx = src.length;
    out[v] = parsePropertyBlock(src.slice(startIdx, endIdx));
  }
  return out;
}

function parsePropertyBlock(src: string): PsetInfo[] {
  const out: PsetInfo[] = [];
  const marker = 'new PropertySetInfo(';
  let cursor = src.indexOf(marker);
  while (cursor !== -1) {
    const argStart = cursor + marker.length;
    // Find the matching close paren — this invocation is multi-line and
    // contains many nested `new XxxPropertyType(...)` calls, so we walk
    // depth properly.
    let depth = 1;
    let i = argStart;
    while (i < src.length && depth > 0) {
      const ch = src.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') {
        i++;
        while (i < src.length && src.charAt(i) !== '"') {
          if (src.charAt(i) === '\\') i++;
          i++;
        }
      } else if (ch === '/' && src.charAt(i + 1) === '/') {
        // Skip line comments.
        while (i < src.length && src.charAt(i) !== '\n') i++;
      }
      i++;
    }
    if (depth !== 0) break;
    const inner = src.slice(argStart, i - 1);
    const parsed = parsePsetArgs(inner);
    if (parsed) out.push(parsed);
    cursor = src.indexOf(marker, i);
  }
  return out;
}

function parsePsetArgs(args: string): PsetInfo | null {
  // The pset call shape:
  //   new PropertySetInfo("Name", new IPropertyTypeInfo[] { ... },
  //       new[] { "IfcWall", ... });
  // Pull out the pset name (1st quoted string), the property-type array,
  // and the applicable-entities array.
  const nameMatch = args.match(/"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const afterName = args.slice(nameMatch.index! + nameMatch[0].length);

  // First find the IPropertyTypeInfo[] block — between `new IPropertyTypeInfo[] {`
  // and the matching `}`. The opening sequence may have arbitrary
  // whitespace between the type and the brace.
  const headRx = /new\s+IPropertyTypeInfo\s*\[\s*\]\s*\{/;
  const headMatch = afterName.match(headRx);
  let propsBlock = '';
  let afterPropsBlock = afterName;
  if (headMatch && headMatch.index !== undefined) {
    const openBrace = headMatch.index + headMatch[0].length - 1;
    const close = findMatchingBrace(afterName, openBrace);
    if (close !== -1) {
      propsBlock = afterName.slice(openBrace + 1, close);
      afterPropsBlock = afterName.slice(close + 1);
    }
  }

  const properties = parseProperties_inner(propsBlock);

  // Last `new[] { ... }` (or equivalent) is the applicable-entities
  // array. Use the tokeniser so we ignore strings that live inside
  // `Definition = "..."` initialisers.
  const tail = tokenise(afterPropsBlock);
  let applicableEntities: string[] = [];
  for (const t of tail) {
    if (t.kind === 'array') applicableEntities = t.items;
  }
  return { name, properties, applicableEntities };
}

function findMatchingBrace(src: string, openIdx: number): number {
  if (openIdx === -1 || src.charAt(openIdx) !== '{') return -1;
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    const ch = src.charAt(i);
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"') {
      i++;
      while (i < src.length && src.charAt(i) !== '"') {
        if (src.charAt(i) === '\\') i++;
        i++;
      }
    }
    i++;
  }
  return depth === 0 ? i - 1 : -1;
}

function parseProperties_inner(block: string): PropertyInfo[] {
  const out: PropertyInfo[] = [];
  const propMarkers = [
    'SingleValuePropertyType',
    'EnumerationPropertyType',
    'ListPropertyType',
    'BoundedPropertyType',
    'ReferencePropertyType',
    'TableValuePropertyType',
    'ComplexPropertyType',
  ];
  // Split on each "new XxxPropertyType(" call.
  const callRx = new RegExp(
    `new\\s+(${propMarkers.join('|')})\\(`,
    'g'
  );
  let m: RegExpExecArray | null;
  while ((m = callRx.exec(block)) !== null) {
    const kind = m[1];
    const argStart = m.index + m[0].length;
    let depth = 1;
    let i = argStart;
    while (i < block.length && depth > 0) {
      const ch = block.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') {
        i++;
        while (i < block.length && block.charAt(i) !== '"') {
          if (block.charAt(i) === '\\') i++;
          i++;
        }
      }
      i++;
    }
    if (depth !== 0) break;
    const inner = block.slice(argStart, i - 1);
    const parsed = parsePropertyCall(kind, inner);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parsePropertyCall(
  kind: string,
  args: string
): PropertyInfo | null {
  const tokens = tokenise(args);
  const strings = tokens
    .filter((t): t is { kind: 'string'; value: string } => t.kind === 'string')
    .map((t) => t.value);
  const arrays = tokens
    .filter((t): t is { kind: 'array'; items: string[] } => t.kind === 'array')
    .map((t) => t.items);
  const name = strings[0];
  if (!name) return null;
  switch (kind) {
    case 'SingleValuePropertyType':
      return { name, kind: 'single', dataType: strings[1] };
    case 'EnumerationPropertyType':
      return { name, kind: 'enumeration', enumeration: arrays[0] ?? [] };
    case 'ListPropertyType':
      return { name, kind: 'list', dataType: strings[1] };
    case 'BoundedPropertyType':
      return { name, kind: 'bounded', dataType: strings[1] };
    case 'ReferencePropertyType':
      return { name, kind: 'reference', dataType: strings[1] };
    default:
      return { name, kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// SchemaInfo.PartOfRelations.g.cs parser
// ---------------------------------------------------------------------------

function parsePartOfRelations(): Record<IfcVersion, PartOfRelation[]> {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.PartOfRelations.g.cs'),
    'utf8'
  );
  const out: Record<IfcVersion, PartOfRelation[]> = {
    Ifc2x3: [],
    Ifc4: [],
    Ifc4x3: [],
  };
  const sections: { version: IfcVersion; marker: string }[] = [
    { version: 'Ifc2x3', marker: 'IfcSchemaVersions.Ifc2x3' },
    { version: 'Ifc4', marker: 'IfcSchemaVersions.Ifc4' },
    { version: 'Ifc4x3', marker: 'IfcSchemaVersions.Ifc4x3' },
  ];
  for (let i = 0; i < sections.length; i++) {
    const start = src.indexOf(sections[i].marker);
    const end =
      i + 1 < sections.length
        ? src.indexOf(sections[i + 1].marker)
        : src.length;
    if (start === -1) continue;
    const slice = src.slice(start, end);
    const callRx = /new PartOfRelationInformation\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = callRx.exec(slice)) !== null) {
      out[sections[i].version].push({
        relation: m[1],
        owner: m[2],
        member: m[3],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SchemaInfo.ObjectTypes.g.cs parser (object → type relations)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SchemaInfo.MeasureNames.g.cs parser (IFC dataType → backing XSD type)
// ---------------------------------------------------------------------------

interface DataTypeRow {
  /** Uppercase IFC dataType name, e.g. `IFCLABEL`. */
  name: string;
  /** Versions in which this data type exists. */
  versions: IfcVersion[];
  /** Backing XSD type token, e.g. `xs:string`, `xs:double`, `xs:boolean`. */
  backingType: string;
}

function parseDataTypes(): DataTypeRow[] {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.MeasureNames.g.cs'),
    'utf8'
  );
  const out: DataTypeRow[] = [];
  const marker = 'new IfcDataTypeInformation(';
  let cursor = src.indexOf(marker);
  while (cursor !== -1) {
    const argStart = cursor + marker.length;
    let depth = 1;
    let i = argStart;
    while (i < src.length && depth > 0) {
      const ch = src.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === '"') {
        i++;
        while (i < src.length && src.charAt(i) !== '"') {
          if (src.charAt(i) === '\\') i++;
          i++;
        }
      }
      i++;
    }
    if (depth !== 0) break;
    const inner = src.slice(argStart, i - 1);
    const tokens = tokenise(inner);
    const strings = tokens.filter(
      (t): t is { kind: 'string'; value: string } => t.kind === 'string'
    );
    const arrays = tokens.filter(
      (t): t is { kind: 'array'; items: string[] } => t.kind === 'array'
    );
    if (strings.length >= 2 && arrays.length >= 1) {
      const name = strings[0].value.toUpperCase();
      const versions = arrays[0].items.filter((v) =>
        ['Ifc2x3', 'Ifc4', 'Ifc4x3'].includes(v)
      ) as IfcVersion[];
      // The last quoted string in the call is the backing type; entries
      // either have 2 strings (name + backing) or many more (when a
      // nested IfcMeasureInformation sits between them).
      const backingType = strings[strings.length - 1].value;
      if (backingType.startsWith('xs:')) {
        out.push({ name, versions, backingType });
      }
    }
    cursor = src.indexOf(marker, i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SchemaInfo.Attributes.g.cs parser
//
// AddAttribute(name, definedOn[], allEntities[], valueTypes[] = []) tells us
// (a) which attributes exist per IFC version and (b) which of them accept
// simple values (the optional 4th argument). We collect the per-version
// attribute → value-type map so the audit can flag `<value>` constraints
// on complex-typed attributes (upstream `IdsAttribute.cs` Report 102).
// ---------------------------------------------------------------------------

interface AttrRow {
  name: string;
  /**
   * Entities the attribute is defined on (uppercase names). Used by the
   * audit to scope the `<value>` check to the applicability entity.
   */
  entities: string[];
  /** Whether the attribute can carry a simple value (4th arg present). */
  hasSimpleValue: boolean;
}

function parseAttributes(): Record<IfcVersion, AttrRow[]> {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.Attributes.g.cs'),
    'utf8'
  );
  const out: Record<IfcVersion, AttrRow[]> = {
    Ifc2x3: [],
    Ifc4: [],
    Ifc4x3: [],
  };
  const sections: { version: IfcVersion; marker: string }[] = [
    { version: 'Ifc2x3', marker: 'GetAttributesIFC2x3' },
    { version: 'Ifc4', marker: 'GetAttributesIFC4(' },
    { version: 'Ifc4x3', marker: 'GetAttributesIFC4x3' },
  ];
  for (let s = 0; s < sections.length; s++) {
    const start = src.indexOf(sections[s].marker);
    if (start === -1) continue;
    let end = src.length;
    for (let t = s + 1; t < sections.length; t++) {
      const e = src.indexOf(sections[t].marker, start + 5);
      if (e !== -1) {
        end = e;
        break;
      }
    }
    const slice = src.slice(start, end);
    const calls = slice.split('AddAttribute(').slice(1);
    for (const call of calls) {
      // Find the matching close paren.
      let depth = 1;
      let i = 0;
      while (i < call.length && depth > 0) {
        const ch = call.charAt(i);
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === '"') {
          i++;
          while (i < call.length && call.charAt(i) !== '"') {
            if (call.charAt(i) === '\\') i++;
            i++;
          }
        }
        i++;
      }
      if (depth !== 0) continue;
      const args = call.slice(0, i - 1);
      const tokens = tokenise(args);
      const strings = tokens.filter(
        (t): t is { kind: 'string'; value: string } => t.kind === 'string'
      );
      const arrays = tokens.filter(
        (t): t is { kind: 'array'; items: string[] } => t.kind === 'array'
      );
      if (strings.length < 1 || arrays.length < 2) continue;
      const name = strings[0].value;
      const allEntities = arrays[1].items.map((e) => e.toUpperCase());
      const hasSimpleValue = arrays.length >= 3;
      out[sections[s].version].push({
        name,
        entities: allEntities,
        hasSimpleValue,
      });
    }
  }
  return out;
}

function emitAttributes(rows: Record<IfcVersion, AttrRow[]>): void {
  const lines: string[] = [HEADER];
  lines.push("import type { IfcAttributeInfo } from '../types.js';\n");
  for (const [v, list] of Object.entries(rows) as [IfcVersion, AttrRow[]][]) {
    // Aggregate per-attribute (name → {entities, hasSimpleValue, hasComplex}).
    // The same name can appear with both kinds across different entities.
    const merged = new Map<
      string,
      {
        entitiesWithValue: Set<string>;
        entitiesWithoutValue: Set<string>;
      }
    >();
    for (const r of list) {
      let m = merged.get(r.name);
      if (!m) {
        m = {
          entitiesWithValue: new Set(),
          entitiesWithoutValue: new Set(),
        };
        merged.set(r.name, m);
      }
      const set = r.hasSimpleValue
        ? m.entitiesWithValue
        : m.entitiesWithoutValue;
      for (const e of r.entities) set.add(e);
    }
    lines.push(
      `export const ATTRIBUTES_${VERSION_KEY[v]}: readonly IfcAttributeInfo[] = [`
    );
    for (const [name, info] of merged) {
      lines.push(
        `  { name: ${ts(name)}, simpleValueEntities: ${ts(
          [...info.entitiesWithValue].sort()
        )}, complexEntities: ${ts([...info.entitiesWithoutValue].sort())} },`
      );
    }
    lines.push('];\n');
  }
  fs.writeFileSync(path.join(outDir, 'attributes.ts'), lines.join('\n'));
  console.log('  attributes.ts — emitted');
}

function emitDataTypes(rows: DataTypeRow[]): void {
  const lines: string[] = [HEADER];
  lines.push("import type { IfcDataTypeInfo } from '../types.js';\n");
  lines.push(
    `export const IFC_DATA_TYPES: readonly IfcDataTypeInfo[] = [`
  );
  for (const r of rows) {
    lines.push(
      `  { name: ${ts(r.name)}, versions: ${ts(r.versions.map(versionKey))}, backingType: ${ts(r.backingType)} },`
    );
  }
  lines.push('];\n');
  fs.writeFileSync(path.join(outDir, 'data-types.ts'), lines.join('\n'));
  console.log(`  data-types.ts — ${rows.length} dataTypes`);
}

function versionKey(v: IfcVersion): string {
  return VERSION_KEY[v];
}

function parseObjectTypes(): Record<IfcVersion, [string, string][]> {
  const src = fs.readFileSync(
    path.join(upstreamDir, 'SchemaInfo.ObjectTypes.g.cs'),
    'utf8'
  );
  const out: Record<IfcVersion, [string, string][]> = {
    Ifc2x3: [],
    Ifc4: [],
    Ifc4x3: [],
  };
  const sections: { version: IfcVersion; marker: string }[] = [
    { version: 'Ifc2x3', marker: 'GetRelationTypesIFC2x3' },
    { version: 'Ifc4', marker: 'GetRelationTypesIFC4' },
    { version: 'Ifc4x3', marker: 'GetRelationTypesIFC4x3' },
  ];
  for (let i = 0; i < sections.length; i++) {
    const start = src.indexOf(sections[i].marker);
    if (start === -1) continue;
    let end = src.length;
    for (let j = i + 1; j < sections.length; j++) {
      const e = src.indexOf(sections[j].marker, start + 5);
      if (e !== -1) {
        end = e;
        break;
      }
    }
    const slice = src.slice(start, end);
    const callRx = /AddRelationType\("([^"]+)",\s*"([^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = callRx.exec(slice)) !== null) {
      out[sections[i].version].push([m[1], m[2]]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const VERSION_KEY: Record<IfcVersion, string> = {
  Ifc2x3: 'IFC2X3',
  Ifc4: 'IFC4',
  Ifc4x3: 'IFC4X3',
};

function ts(value: unknown): string {
  return JSON.stringify(value);
}

function emitEntities(
  classes: Record<IfcVersion, ClassInfo[]>,
  objectTypes: Record<IfcVersion, [string, string][]>
): void {
  for (const [v, list] of Object.entries(classes) as [IfcVersion, ClassInfo[]][]) {
    const otMap = new Map(objectTypes[v]);
    const lines: string[] = [];
    lines.push(HEADER);
    lines.push("import type { IfcEntityInfo } from '../types.js';\n");
    lines.push(`export const ENTITIES_${VERSION_KEY[v]}: readonly IfcEntityInfo[] = [`);
    for (const c of list) {
      const objType = otMap.get(c.name.toUpperCase());
      lines.push(
        `  { name: ${ts(c.name)}, parent: ${ts(c.parent || undefined)}, ` +
          `abstract: ${c.abstract}, predefinedTypes: ${ts(c.predefinedTypes)}, ` +
          `attributes: ${ts(c.attributes)}, source: ${ts(c.source || undefined)}` +
          (objType ? `, typeEntity: ${ts(objType)}` : '') +
          ' },'
      );
    }
    lines.push('];\n');
    fs.writeFileSync(
      path.join(outDir, `entities-${v.toLowerCase()}.ts`),
      lines.join('\n')
    );
    console.log(
      `  entities-${v.toLowerCase()}.ts — ${list.length} entities`
    );
  }
}

function emitPropertySets(
  psets: Record<IfcVersion, PsetInfo[]>
): void {
  for (const [v, list] of Object.entries(psets) as [IfcVersion, PsetInfo[]][]) {
    const lines: string[] = [];
    lines.push(HEADER);
    lines.push("import type { IfcPropertySetInfo } from '../types.js';\n");
    lines.push(
      `export const PROPERTY_SETS_${VERSION_KEY[v]}: readonly IfcPropertySetInfo[] = [`
    );
    for (const p of list) {
      lines.push('  {');
      lines.push(`    name: ${ts(p.name)},`);
      lines.push(`    applicableEntities: ${ts(p.applicableEntities)},`);
      lines.push(`    properties: [`);
      for (const prop of p.properties) {
        lines.push(
          `      { name: ${ts(prop.name)}, kind: ${ts(prop.kind)}` +
            (prop.dataType ? `, dataType: ${ts(prop.dataType)}` : '') +
            (prop.enumeration ? `, enumeration: ${ts(prop.enumeration)}` : '') +
            ' },'
        );
      }
      lines.push(`    ],`);
      lines.push('  },');
    }
    lines.push('];\n');
    fs.writeFileSync(
      path.join(outDir, `psets-${v.toLowerCase()}.ts`),
      lines.join('\n')
    );
    const totalProps = list.reduce((n, p) => n + p.properties.length, 0);
    console.log(
      `  psets-${v.toLowerCase()}.ts — ${list.length} psets, ${totalProps} properties`
    );
  }
}

function emitPartOfRelations(
  relations: Record<IfcVersion, PartOfRelation[]>
): void {
  const lines: string[] = [HEADER];
  lines.push("import type { PartOfRelationInfo } from '../types.js';\n");
  for (const [v, list] of Object.entries(relations) as [IfcVersion, PartOfRelation[]][]) {
    lines.push(
      `export const PART_OF_RELATIONS_${VERSION_KEY[v]}: readonly PartOfRelationInfo[] = [`
    );
    for (const r of list) {
      lines.push(
        `  { relation: ${ts(r.relation)}, owner: ${ts(r.owner)}, member: ${ts(r.member)} },`
      );
    }
    lines.push('];\n');
  }
  fs.writeFileSync(path.join(outDir, 'partof-relations.ts'), lines.join('\n'));
  console.log(
    `  partof-relations.ts — ${Object.values(relations).reduce((n, l) => n + l.length, 0)} relations`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  console.log('Parsing upstream IDS-Audit-tool schema data…');
  const classes = parseSchemas();
  const psets = parseProperties();
  const relations = parsePartOfRelations();
  const objectTypes = parseObjectTypes();
  const dataTypes = parseDataTypes();
  const attrs = parseAttributes();

  for (const [v, list] of Object.entries(classes) as [IfcVersion, ClassInfo[]][]) {
    console.log(`  ${VERSION_KEY[v]}: ${list.length} entities, ${psets[v].length} psets, ${relations[v].length} partOf relations, ${objectTypes[v].length} obj→type pairs`);
  }
  console.log('Emitting TypeScript modules…');
  emitEntities(classes, objectTypes);
  emitPropertySets(psets);
  emitPartOfRelations(relations);
  emitDataTypes(dataTypes);
  emitAttributes(attrs);
  console.log('Done.');
}

main();
