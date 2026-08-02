/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-agnostic STEP (ISO 10303-21) serialization primitives.
 *
 * This is the SINGLE source of truth for STEP value / entity / header
 * serialization and parsing. The codegen-emitted per-schema bundles and the
 * parser runtime bundle both re-export these symbols, binding their own
 * `SCHEMA_REGISTRY` to the registry-coupled helpers (`toStepLineWithRegistry`,
 * `generateStepFileWithRegistry`). The logic therefore exists in exactly one
 * place and the per-schema `serializers.ts` files are thin, drift-proof
 * re-exports.
 */

/**
 * STEP value types
 */
export type StepValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StepValue[]
  | EntityRef
  | EnumValue;

/**
 * Entity reference (#123)
 */
export interface EntityRef {
  ref: number;
}

/**
 * Enum value (.VALUE.)
 */
export interface EnumValue {
  enum: string;
}

/**
 * Base interface for serializable entities
 */
export interface StepEntity {
  /** Express ID (#123) */
  expressId: number;
  /** IFC type name */
  type: string;
  /** Attribute values */
  [key: string]: unknown;
}

/**
 * Minimal structural view of a schema registry that {@link toStepLineWithRegistry}
 * needs. The generated `SchemaRegistry` (with full entity metadata) satisfies
 * this, so callers pass their bundle's `SCHEMA_REGISTRY` directly.
 */
export interface StepSchemaRegistry {
  entities: Record<string, { allAttributes?: ReadonlyArray<{ name: string }> } | undefined>;
}

/**
 * Check if value is an entity reference
 */
export function isEntityRef(value: unknown): value is EntityRef {
  return typeof value === 'object' && value !== null && 'ref' in value;
}

/**
 * Check if value is an enum value
 */
export function isEnumValue(value: unknown): value is EnumValue {
  return typeof value === 'object' && value !== null && 'enum' in value;
}

/**
 * Create an entity reference
 */
export function ref(id: number): EntityRef {
  return { ref: id };
}

/**
 * Create an enum value
 */
export function enumVal(value: string): EnumValue {
  return { enum: value };
}

/**
 * Format a finite number as a valid ISO-10303-21 STEP REAL literal.
 *
 * A conforming REAL always carries a decimal point in its mantissa and an
 * uppercase `E` for the exponent. JavaScript's `Number.prototype.toString`
 * emits neither reliably: an integer-valued exponential prints as `5e-8`
 * (lowercase `e`, no mantissa dot) and would become an invalid token if a bare
 * `.` were appended (`5e-8.`). This rewrites the mantissa/exponent into the
 * STEP form (`5.E-8`, `1.5E-7`, `1.E+21`).
 *
 * This is the SINGLE source of the mantissa/`E` rewrite; the export package's
 * `toStepReal` / `toStepRealScaled` reuse it so the rule lives in one place.
 * Callers guard non-finite input (`serializeValue` maps it to `$`).
 */
export function formatStepReal(value: number): string {
  const s = value.toString();
  const e = s.indexOf('e');
  if (e !== -1) {
    let mantissa = s.slice(0, e);
    const exp = s.slice(e + 1);
    if (!mantissa.includes('.')) mantissa += '.';
    return `${mantissa}E${exp}`;
  }
  return s.includes('.') ? s : `${s}.`;
}

/**
 * Serialize a single value to STEP format
 */
export function serializeValue(value: StepValue): string {
  // Null/undefined -> $
  if (value === null || value === undefined) {
    return '$';
  }

  // Derived value -> *
  if (value === '*') {
    return '*';
  }

  // Boolean
  if (typeof value === 'boolean') {
    return value ? '.T.' : '.F.';
  }

  // Number
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '$';
    }
    return formatStepReal(value);
  }

  // String
  if (typeof value === 'string') {
    return "'" + escapeStepString(value) + "'";
  }

  // Entity reference
  if (isEntityRef(value)) {
    return '#' + value.ref;
  }

  // Enum value
  if (isEnumValue(value)) {
    return '.' + value.enum + '.';
  }

  // Array/List
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '()';
    }
    return '(' + value.map(v => serializeValue(v as StepValue)).join(',') + ')';
  }

  // Object (shouldn't happen for valid STEP values)
  return '$';
}

/**
 * Escape a string for STEP format.
 *
 * Backslash and single-quote are doubled per ISO-10303-21. Control characters
 * (CR/LF and other C0 codes plus DEL) are collapsed to a single space so a
 * value can never inject a physical line break into the line-oriented STEP
 * output (matching the export package's escaper) — a raw newline in a header
 * or attribute value would otherwise split one record across two lines.
 */
function escapeStepString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')  // Backslash
    .replace(/'/g, "''")     // Single quote
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]+/g, ' '); // Collapse control chars
}

/**
 * Serialize an entity to a STEP line, resolving its attribute order from the
 * supplied schema registry.
 */
export function toStepLineWithRegistry(registry: StepSchemaRegistry, entity: StepEntity): string {
  const schema = registry.entities[entity.type];
  if (!schema) {
    throw new Error(`Unknown entity type: ${entity.type}`);
  }

  // Get all attributes in order
  const values: string[] = [];
  for (const attr of schema.allAttributes ?? []) {
    const value = entity[attr.name];
    values.push(serializeValue(value as StepValue));
  }

  return `#${entity.expressId}=${entity.type.toUpperCase()}(${values.join(',')});`;
}

/**
 * Generate STEP file header.
 *
 * `description`, `author`, and `organization` accept either a single string
 * or an array, so a round-trip export can reproduce a multi-item source
 * `FILE_DESCRIPTION` / multiple authors verbatim. `schema` is a free string so
 * exact tokens like `IFC4X3_ADD2` survive (the coarse enum would flatten them).
 * All string fields are STEP-escaped.
 */
export function generateHeader(options: {
  description?: string | string[];
  implementationLevel?: string;
  author?: string | string[];
  organization?: string | string[];
  application?: string;
  schema: string;
  filename?: string;
  timeStamp?: string;
  preprocessorVersion?: string;
  originatingSystem?: string;
  authorization?: string;
}): string {
  const toList = (v: string | string[] | undefined, fallback: string[]): string[] =>
    v === undefined ? fallback : Array.isArray(v) ? v : [v];
  const quoteList = (items: string[]): string =>
    '(' + items.map(s => "'" + escapeStepString(s) + "'").join(',') + ')';

  const now = options.timeStamp ?? new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const description = toList(options.description, ['ViewDefinition [CoordinationView]']);
  const implementationLevel = options.implementationLevel || '2;1';
  const authors = toList(options.author, ['']);
  const orgs = toList(options.organization, ['']);
  const app = options.application || 'ifc-lite';
  const preprocessor = options.preprocessorVersion || app;
  const originatingSystem = options.originatingSystem || app;
  const authorization = options.authorization ?? '';
  const filename = options.filename || 'output.ifc';

  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(${quoteList(description)},'${escapeStepString(implementationLevel)}');
FILE_NAME('${escapeStepString(filename)}','${escapeStepString(now)}',${quoteList(authors)},${quoteList(orgs)},'${escapeStepString(preprocessor)}','${escapeStepString(originatingSystem)}','${escapeStepString(authorization)}');
FILE_SCHEMA(('${escapeStepString(options.schema)}'));
ENDSEC;
`;
}

/**
 * Generate complete STEP file content, resolving entity attribute order from
 * the supplied schema registry.
 */
export function generateStepFileWithRegistry(
  registry: StepSchemaRegistry,
  entities: StepEntity[],
  options: Parameters<typeof generateHeader>[0]
): string {
  const header = generateHeader(options);

  // Sort entities by ID for deterministic output
  const sorted = [...entities].sort((a, b) => a.expressId - b.expressId);

  const data = sorted.map(e => toStepLineWithRegistry(registry, e)).join('\n');

  return `${header}DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * Parse a STEP value from string
 */
export function parseStepValue(str: string): StepValue {
  str = str.trim();

  // Null
  if (str === '$') {
    return null;
  }

  // Derived
  if (str === '*') {
    return '*' as unknown as StepValue;
  }

  // Boolean
  if (str === '.T.') {
    return true;
  }
  if (str === '.F.') {
    return false;
  }
  if (str === '.U.') {
    return null; // Unknown/indeterminate
  }

  // Entity reference
  if (str.startsWith('#')) {
    return { ref: parseInt(str.substring(1), 10) };
  }

  // Enum
  if (str.startsWith('.') && str.endsWith('.')) {
    return { enum: str.substring(1, str.length - 1) };
  }

  // String
  if (str.startsWith("'") && str.endsWith("'")) {
    return unescapeStepString(str.substring(1, str.length - 1));
  }

  // List
  if (str.startsWith('(') && str.endsWith(')')) {
    return parseStepList(str);
  }

  // Number
  const num = parseFloat(str);
  if (!isNaN(num)) {
    return num;
  }

  // Unknown
  return str;
}

/**
 * Parse a STEP list
 */
function parseStepList(str: string): StepValue[] {
  // Remove outer parentheses
  const inner = str.substring(1, str.length - 1).trim();
  if (inner === '') {
    return [];
  }

  const values: StepValue[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];

    if (char === '(' || char === '[') {
      depth++;
      current += char;
    } else if (char === ')' || char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      values.push(parseStepValue(current));
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    values.push(parseStepValue(current));
  }

  return values;
}

/**
 * Unescape a STEP string
 */
function unescapeStepString(str: string): string {
  return str
    .replace(/''/g, "'")
    .replace(/\\\\/g, '\\');
}
