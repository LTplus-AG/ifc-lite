/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript Code Generator
 *
 * Generates TypeScript interfaces, types, and schema registry from parsed EXPRESS schemas.
 */

import type {
  ExpressSchema,
  EntityDefinition,
  AttributeDefinition,
  EnumDefinition,
  SelectDefinition,
  TypeDefinition,
} from './express-parser.js';
import { buildSchemaRegistry, concreteRelationshipTypes, encodeSchemaRegistry, SCHEMA_REGISTRY_DECODER_SOURCE } from './schema-registry-codec.js';

export interface GeneratedCode {
  entities: string;       // Entity interfaces
  types: string;          // Type aliases
  enums: string;          // Enum definitions
  selects: string;        // Union types
  schemaRegistry: string; // Runtime schema metadata
}

/**
 * Generate all TypeScript code from EXPRESS schema
 */
export function generateTypeScript(schema: ExpressSchema): GeneratedCode {
  return {
    entities: generateEntityInterfaces(schema),
    types: generateTypeAliases(schema),
    enums: generateEnums(schema),
    selects: generateSelectTypes(schema),
    schemaRegistry: generateSchemaRegistry(schema),
  };
}

/**
 * Generate entity interfaces
 */
function generateEntityInterfaces(schema: ExpressSchema): string {
  // Collect type, enum, and select names - filtering types that are also enums/selects
  const enumNamesSet = new Set(schema.enums.map(e => e.name));
  const selectNamesSet = new Set(schema.selects.map(s => s.name));

  // Types to import from types.ts (exclude those that are enums or selects)
  const typeNames = schema.types
    .filter(t => !enumNamesSet.has(t.name) && !selectNamesSet.has(t.name))
    .map(t => t.name);
  const enumNames = schema.enums.map(e => e.name);
  const selectNames = schema.selects.map(s => s.name);

  let code = `/**
 * IFC Entity Interfaces
 * Generated from EXPRESS schema: ${schema.name}
 *
 * DO NOT EDIT - This file is auto-generated
 */

`;

  // Add imports for types, enums, and selects
  if (typeNames.length > 0) {
    code += `import type {\n  ${typeNames.join(',\n  ')},\n} from './types.js';\n\n`;
  }

  if (enumNames.length > 0) {
    code += `import type {\n  ${enumNames.join(',\n  ')},\n} from './enums.js';\n\n`;
  }

  if (selectNames.length > 0) {
    code += `import type {\n  ${selectNames.join(',\n  ')},\n} from './selects.js';\n\n`;
  }

  // Sort entities by dependency order (parents before children)
  const sortedEntities = topologicalSort(schema.entities);

  for (const entity of sortedEntities) {
    code += generateEntityInterface(entity, schema);
    code += '\n\n';
  }

  return `${code.trimEnd()}\n`;
}

/**
 * Generate a single entity interface
 */
function generateEntityInterface(
  entity: EntityDefinition,
  schema: ExpressSchema
): string {
  let code = '';

  // Add JSDoc comment
  code += `/**\n * ${entity.name}\n`;
  if (entity.isAbstract) {
    code += ` * @abstract\n`;
  }
  if (entity.supertype) {
    code += ` * @extends ${entity.supertype}\n`;
  }
  code += ` */\n`;

  // Generate interface
  code += `export interface ${entity.name}`;

  // Add extends clause
  if (entity.supertype) {
    code += ` extends ${entity.supertype}`;
  }

  code += ` {\n`;

  // Add attributes (only this level, not inherited)
  for (const attr of entity.attributes) {
    code += generateAttribute(attr);
  }

  code += `}`;

  return code;
}

/**
 * Generate an attribute declaration
 */
function generateAttribute(attr: AttributeDefinition): string {
  let code = `  ${attr.name}`;

  // Add optional marker
  if (attr.optional) {
    code += '?';
  }

  code += ': ';

  // Map EXPRESS type to TypeScript type
  let tsType = mapExpressTypeToTypeScript(attr.type);

  // Wrap in array if needed
  // Note: attr.type may already contain [] for nested collections from the parser
  if (attr.isArray || attr.isList || attr.isSet) {
    // Parenthesize union element types so `boolean | null` becomes
    // `(boolean | null)[]` rather than the precedence-misparsed `boolean | null[]`.
    tsType = /\|/.test(tsType) ? `(${tsType})[]` : `${tsType}[]`;
  }

  code += tsType;
  code += ';\n';

  return code;
}

/**
 * Map EXPRESS types to TypeScript types
 */
function mapExpressTypeToTypeScript(expressType: string): string {
  // Handle basic EXPRESS types
  const typeMap: Record<string, string> = {
    REAL: 'number',
    INTEGER: 'number',
    NUMBER: 'number',
    BOOLEAN: 'boolean',
    LOGICAL: 'boolean | null',
    STRING: 'string',
    BINARY: 'string',
  };

  // Handle STRING(N) and STRING(N) FIXED patterns
  if (/^STRING\s*\(/i.test(expressType)) {
    return 'string';
  }

  // Handle BINARY(N) patterns
  if (/^BINARY\s*\(/i.test(expressType)) {
    return 'string';
  }

  // Handle LIST [N:?] OF X, SET [N:?] OF X, ARRAY [N:M] OF X patterns
  const collectionMatch = expressType.match(/^(LIST|SET|ARRAY)\s*\[.*?\]\s*OF\s+(.+)$/i);
  if (collectionMatch) {
    const innerType = mapExpressTypeToTypeScript(collectionMatch[2].trim());
    // Parenthesize union element types to preserve `(union)[]` precedence.
    return /\|/.test(innerType) ? `(${innerType})[]` : `${innerType}[]`;
  }

  // Handle ENUMERATION OF (...) - these should be handled by enum generation
  if (/^ENUMERATION\s+OF/i.test(expressType)) {
    return 'string'; // Fallback to string for inline enumerations
  }

  // Check if it's a measure type (ends with Measure)
  if (expressType.endsWith('Measure')) {
    return 'number';
  }

  // Check if it's a simple type in our map
  const upperType = expressType.toUpperCase();
  if (typeMap[upperType]) {
    return typeMap[upperType];
  }

  // Check for IFC types
  if (expressType.startsWith('Ifc')) {
    return expressType;
  }

  // Default: use as-is (likely a custom type or entity reference)
  return expressType;
}

/**
 * Generate type aliases
 */
function generateTypeAliases(schema: ExpressSchema): string {
  // Collect entity names and type names
  const entityNames = new Set(schema.entities.map(e => e.name));
  const enumNames = new Set(schema.enums.map(e => e.name));
  const selectNames = new Set(schema.selects.map(s => s.name));

  // Filter out types that are also defined as enums or selects (they have separate files)
  const typesToGenerate = schema.types.filter(
    t => !enumNames.has(t.name) && !selectNames.has(t.name)
  );

  // Track referenced entities
  const referencedEntities = new Set<string>();

  for (const type of typesToGenerate) {
    const mapped = mapExpressTypeToTypeScript(type.underlyingType);
    // Check if the underlying type or array element type is an entity
    const baseType = mapped.replace(/\[\]$/, '');
    if (entityNames.has(baseType)) {
      referencedEntities.add(baseType);
    }
  }

  let code = `/**
 * IFC Type Aliases
 * Generated from EXPRESS schema: ${schema.name}
 *
 * DO NOT EDIT - This file is auto-generated
 */

`;

  // Add imports for referenced entities (circular but allowed with import type)
  if (referencedEntities.size > 0) {
    const sortedEntities = Array.from(referencedEntities).sort();
    code += `import type {\n  ${sortedEntities.join(',\n  ')},\n} from './entities.js';\n\n`;
  }

  for (const type of typesToGenerate) {
    code += `/** ${type.name} */\n`;
    code += `export type ${type.name} = ${mapExpressTypeToTypeScript(type.underlyingType)};\n\n`;
  }

  return code;
}

/**
 * Generate enum definitions
 */
function generateEnums(schema: ExpressSchema): string {
  let code = `/**
 * IFC Enumerations
 * Generated from EXPRESS schema: ${schema.name}
 *
 * DO NOT EDIT - This file is auto-generated
 */

`;

  for (const enumDef of schema.enums) {
    code += generateEnum(enumDef);
    code += '\n\n';
  }

  return code;
}

/**
 * Generate a single enum
 */
function generateEnum(enumDef: EnumDefinition): string {
  let code = `/** ${enumDef.name} */\n`;
  code += `export enum ${enumDef.name} {\n`;

  for (const value of enumDef.values) {
    // Convert to PascalCase for enum member
    const memberName = value.toUpperCase();
    code += `  ${memberName} = '${value}',\n`;
  }

  code += `}`;

  return code;
}

/**
 * Generate SELECT type unions
 */
function generateSelectTypes(schema: ExpressSchema): string {
  // Collect referenced types from selects
  const entityNames = new Set(schema.entities.map(e => e.name));
  const enumNames = new Set(schema.enums.map(e => e.name));
  const selectNames = new Set(schema.selects.map(s => s.name));
  // Types in types.ts (filtered: not enums, not selects)
  const typeNames = new Set(
    schema.types
      .filter(t => !enumNames.has(t.name) && !selectNames.has(t.name))
      .map(t => t.name)
  );

  // Track which names are referenced in selects
  const referencedEntities = new Set<string>();
  const referencedTypes = new Set<string>();
  const referencedEnums = new Set<string>();

  for (const select of schema.selects) {
    for (const typeName of select.types) {
      const mapped = mapExpressTypeToTypeScript(typeName);
      if (entityNames.has(mapped)) {
        referencedEntities.add(mapped);
      } else if (typeNames.has(mapped)) {
        referencedTypes.add(mapped);
      } else if (enumNames.has(mapped)) {
        referencedEnums.add(mapped);
      }
      // Selects referencing other selects are fine - they're in the same file
    }
  }

  let code = `/**
 * IFC SELECT Types (Unions)
 * Generated from EXPRESS schema: ${schema.name}
 *
 * DO NOT EDIT - This file is auto-generated
 */

`;

  // Add imports for entities (circular but allowed with import type)
  if (referencedEntities.size > 0) {
    const sortedEntities = Array.from(referencedEntities).sort();
    code += `import type {\n  ${sortedEntities.join(',\n  ')},\n} from './entities.js';\n\n`;
  }

  // Add imports for types
  if (referencedTypes.size > 0) {
    const sortedTypes = Array.from(referencedTypes).sort();
    code += `import type {\n  ${sortedTypes.join(',\n  ')},\n} from './types.js';\n\n`;
  }

  // Add imports for enums
  if (referencedEnums.size > 0) {
    const sortedEnums = Array.from(referencedEnums).sort();
    code += `import type {\n  ${sortedEnums.join(',\n  ')},\n} from './enums.js';\n\n`;
  }

  for (const select of schema.selects) {
    code += `/** ${select.name} */\n`;
    code += `export type ${select.name} = `;

    // Join types with |
    const tsTypes = select.types.map(t => mapExpressTypeToTypeScript(t));
    code += tsTypes.join(' | ');

    code += ';\n\n';
  }

  return code;
}

/**
 * Generate schema registry with runtime metadata.
 *
 * Everything inside the template below is EMITTED TEXT. A bare backtick in it
 * closes the literal (only `tsc` on this package catches that), and every
 * lookup it emits must be an own-property check: registry objects are plain
 * objects, so `in` and `obj[key]` would answer for `constructor`,
 * `toString` and `__proto__` (#3063).
 */
function generateSchemaRegistry(schema: ExpressSchema): string {
  let code = `/**
 * IFC Schema Registry
 * Generated from EXPRESS schema: ${schema.name}
 *
 * Runtime metadata for IFC entities, types, and relationships.
 *
 * DO NOT EDIT - This file is auto-generated
 */

export interface EntityMetadata {
  name: string;
  isAbstract: boolean;
  parent?: string;
  attributes: AttributeMetadata[];
  allAttributes?: AttributeMetadata[];  // Including inherited
  inheritanceChain?: string[];  // From root to entity
}

export interface AttributeMetadata {
  name: string;
  type: string;
  optional: boolean;
  isArray: boolean;
  isList: boolean;
  isSet: boolean;
  arrayBounds?: [number, number];
}

export interface SchemaRegistry {
  name: string;
  entities: Record<string, EntityMetadata>;
  types: Record<string, string>;  // name -> underlying type
  enums: Record<string, string[]>;  // name -> values
  selects: Record<string, string[]>;  // name -> types
}

/**
 * This schema's registry in the compact form of
 * \`packages/codegen/src/schema-registry-codec.ts\`, decoded on first use.
 * A bundle that never asks a question of this schema only scans the string.
 */
const ENCODED_SCHEMA_REGISTRY = ${JSON.stringify(JSON.stringify(encodeSchemaRegistry(buildSchemaRegistry(schema))))};

let decodedSchemaRegistry: SchemaRegistry | undefined;

/**
 * The registry, decoded from {@link ENCODED_SCHEMA_REGISTRY} the first time it
 * is asked for and the same object afterwards. Code that may never need this
 * schema should call this rather than read {@link SCHEMA_REGISTRY}, which
 * decodes when the module loads.
 */
export function getSchemaRegistry(): SchemaRegistry {
  if (decodedSchemaRegistry === undefined) {
    decodedSchemaRegistry = decodeSchemaRegistry(JSON.parse(ENCODED_SCHEMA_REGISTRY) as EncodedSchemaRegistry);
  }
  return decodedSchemaRegistry;
}

const eagerRegistriesEvaluated: string[] = [];

/** The exported-constant form: returns \`get()\`, and records a marker that
 * survives in a built bundle exactly where this constant does
 * (\`apps/viewer/scripts/check-schema-tables-lazy.mjs\` keeps it off the
 * viewer's startup chunks). */
function eagerSchemaRegistry(marker: string, get: () => SchemaRegistry): SchemaRegistry {
  eagerRegistriesEvaluated.push(marker);
  return get();
}

export const SCHEMA_REGISTRY: SchemaRegistry = /* @__PURE__ */ eagerSchemaRegistry('ifc-lite-eager-table:SCHEMA_REGISTRY:${schema.name}', getSchemaRegistry);

/**
 * Every concrete (non-abstract) \`IfcRelationship\` subtype of this schema, as
 * an upper-cased STEP keyword, in registry order. Generated from the registry,
 * so a relationship gate can be built without decoding it.
 */
export const CONCRETE_RELATIONSHIP_TYPES: readonly string[] = ${JSON.stringify(concreteRelationshipTypes(buildSchemaRegistry(schema)))};

/**
 * Get entity metadata by name (case-insensitive)
 */
export function getEntityMetadata(typeName: string): EntityMetadata | undefined {
  // Normalize to IfcXxx format
  const normalized = normalizeTypeName(typeName);
  const entities = getSchemaRegistry().entities;
  if (!Object.prototype.hasOwnProperty.call(entities, normalized)) return undefined;
  return entities[normalized];
}

/**
 * Get all attributes for an entity (including inherited)
 */
export function getAllAttributesForEntity(typeName: string): AttributeMetadata[] {
  const metadata = getEntityMetadata(typeName);
  return metadata?.allAttributes || [];
}

/**
 * Get inheritance chain for an entity
 */
export function getInheritanceChainForEntity(typeName: string): string[] {
  const metadata = getEntityMetadata(typeName);
  return metadata?.inheritanceChain || [];
}

/**
 * Check if a type is a known entity
 */
export function isKnownEntity(typeName: string): boolean {
  return getEntityMetadata(typeName) !== undefined;
}

/**
 * Normalize type name to IfcXxx format
 */
function normalizeTypeName(name: string): string {
  // Already in IfcPascalCase — return as-is
  if (name.startsWith('Ifc') && name.length > 3 && name[3] >= 'A' && name[3] <= 'Z') {
    return name;
  }
  // Convert UPPERCASE STEP names: IFCWALL -> IfcWall, IFCWALLTYPE -> IfcWallType
  const upper = name.toUpperCase();
  if (upper.startsWith('IFC')) {
    const rest = upper.substring(3);
    // Lookup by matching uppercase keys in the registry
    for (const key of Object.keys(getSchemaRegistry().entities)) {
      if (key.toUpperCase() === 'IFC' + rest) return key;
    }
    // Fallback: best-effort single-word conversion
    return 'Ifc' + rest.charAt(0) + rest.substring(1).toLowerCase();
  }
  return name;
}

${SCHEMA_REGISTRY_DECODER_SOURCE}`;

  return code;
}

/**
 * Topological sort of entities by dependency order
 * Ensures parent entities are generated before children
 */
function topologicalSort(entities: EntityDefinition[]): EntityDefinition[] {
  const sorted: EntityDefinition[] = [];
  const visited = new Set<string>();

  function visit(entity: EntityDefinition) {
    if (visited.has(entity.name)) {
      return;
    }

    visited.add(entity.name);

    // Visit parent first
    if (entity.supertype) {
      const parent = entities.find(e => e.name === entity.supertype);
      if (parent) {
        visit(parent);
      }
    }

    sorted.push(entity);
  }

  for (const entity of entities) {
    visit(entity);
  }

  return sorted;
}

/**
 * Write generated code to files
 */
export function writeGeneratedFiles(
  code: GeneratedCode,
  outputDir: string
): { entities: string; types: string; enums: string; selects: string; schema: string } {
  return {
    entities: `${outputDir}/entities.ts`,
    types: `${outputDir}/types.ts`,
    enums: `${outputDir}/enums.ts`,
    selects: `${outputDir}/selects.ts`,
    schema: `${outputDir}/schema-registry.ts`,
  };
}
