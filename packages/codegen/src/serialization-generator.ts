/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialization Generator
 *
 * Generates TypeScript code for serializing IFC entities to STEP format.
 */

import type { ExpressSchema, EntityDefinition, AttributeDefinition } from './express-parser.js';
import { getAllAttributes } from './express-parser.js';

/**
 * Generate serialization support code
 */
export function generateSerializers(schema: ExpressSchema): string {
  let code = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Serialization Support
 * Generated from EXPRESS schema: ${schema.name}
 *
 * Utilities for serializing IFC entities to STEP format.
 *
 * DO NOT EDIT - This file is auto-generated
 */

import { SCHEMA_REGISTRY } from './schema-registry.js';

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
    // Use exponential notation for large/small numbers
    if (Math.abs(value) > 1e10 || (Math.abs(value) < 1e-10 && value !== 0)) {
      return value.toExponential(10).toUpperCase().replace('E+', 'E');
    }
    // Otherwise use fixed notation
    const str = value.toString();
    // Ensure there's a decimal point for REAL values
    return str.includes('.') ? str : str + '.';
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
 * Escape a string for STEP format
 */
function escapeStepString(str: string): string {
  return str
    .replace(/\\\\/g, '\\\\\\\\')  // Backslash
    .replace(/'/g, "''");           // Single quote
}

/**
 * Serialize an entity to a STEP line
 */
export function toStepLine(entity: StepEntity): string {
  const schema = SCHEMA_REGISTRY.entities[entity.type];
  if (!schema) {
    throw new Error(\`Unknown entity type: \${entity.type}\`);
  }

  // Get all attributes in order
  const values: string[] = [];
  for (const attr of schema.allAttributes) {
    const value = entity[attr.name];
    values.push(serializeValue(value as StepValue));
  }

  return \`#\${entity.expressId}=\${entity.type.toUpperCase()}(\${values.join(',')});\`;
}

/**
 * Generate STEP file header.
 *
 * \`description\`, \`author\`, and \`organization\` accept either a single string
 * or an array, so a round-trip export can reproduce a multi-item source
 * \`FILE_DESCRIPTION\` / multiple authors verbatim. \`schema\` is a free string so
 * exact tokens like \`IFC4X3_ADD2\` survive (the coarse enum would flatten them).
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

  return \`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(\${quoteList(description)},'\${escapeStepString(implementationLevel)}');
FILE_NAME('\${escapeStepString(filename)}','\${escapeStepString(now)}',\${quoteList(authors)},\${quoteList(orgs)},'\${escapeStepString(preprocessor)}','\${escapeStepString(originatingSystem)}','\${escapeStepString(authorization)}');
FILE_SCHEMA(('\${escapeStepString(options.schema)}'));
ENDSEC;
\`;
}

/**
 * Generate complete STEP file content
 */
export function generateStepFile(
  entities: StepEntity[],
  options: Parameters<typeof generateHeader>[0]
): string {
  const header = generateHeader(options);

  // Sort entities by ID for deterministic output
  const sorted = [...entities].sort((a, b) => a.expressId - b.expressId);

  const data = sorted.map(e => toStepLine(e)).join('\\n');

  return \`\${header}DATA;
\${data}
ENDSEC;
END-ISO-10303-21;
\`;
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
    .replace(/\\\\\\\\/g, '\\\\');
}
`;

  return code;
}
