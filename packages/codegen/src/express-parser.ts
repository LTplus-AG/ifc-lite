/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EXPRESS Schema Parser
 *
 * Parses IFC EXPRESS schemas (.exp files) into an AST for code generation.
 *
 * EXPRESS is a data modeling language (ISO 10303-11) used to define IFC schemas.
 * We parse the subset needed for TypeScript code generation:
 * - ENTITY definitions (with attributes, inheritance, WHERE clauses)
 * - TYPE definitions (simple types, enumerations, selects)
 * - Comments
 */

export interface ExpressSchema {
  name: string;
  entities: EntityDefinition[];
  types: TypeDefinition[];
  enums: EnumDefinition[];
  selects: SelectDefinition[];
}

export interface EntityDefinition {
  name: string;
  isAbstract: boolean;
  supertype?: string;  // SUBTYPE OF
  supertypeOf?: string[];  // SUPERTYPE OF (subtypes)
  attributes: AttributeDefinition[];
  derived?: DerivedAttribute[];
  inverse?: InverseAttribute[];
  whereRules?: string[];
  uniqueRules?: string[];
}

export interface AttributeDefinition {
  name: string;
  type: string;
  optional: boolean;
  isArray: boolean;
  isList: boolean;
  isSet: boolean;
  arrayBounds?: [number, number];  // [min, max] or [exact, exact]
}

export interface DerivedAttribute {
  name: string;
  type: string;
  expression: string;
}

export interface InverseAttribute {
  name: string;
  type: string;
  reference: string;
  for: string;
}

export interface TypeDefinition {
  name: string;
  underlyingType: string;  // e.g., "REAL", "STRING", "INTEGER"
  whereRules?: string[];
}

export interface EnumDefinition {
  name: string;
  values: string[];
}

export interface SelectDefinition {
  name: string;
  types: string[];  // Union of types
}

/**
 * Parse an EXPRESS schema file
 */
export function parseExpressSchema(content: string): ExpressSchema {
  // Remove comments
  content = removeComments(content);

  // Extract schema name
  const schemaMatch = content.match(/SCHEMA\s+(\w+)\s*;/);
  const schemaName = schemaMatch ? schemaMatch[1] : 'UNKNOWN';

  // Parse different constructs
  const entities = parseEntities(content);
  const types = parseTypes(content);
  const enums = parseEnums(content);
  const selects = parseSelects(content);

  return {
    name: schemaName,
    entities,
    types,
    enums,
    selects,
  };
}

/**
 * Remove (* ... *) comments from EXPRESS
 */
function removeComments(content: string): string {
  // Remove multi-line comments (* ... *)
  return content.replace(/\(\*[\s\S]*?\*\)/g, '');
}

/**
 * Parse ENTITY definitions
 */
function parseEntities(content: string): EntityDefinition[] {
  const entities: EntityDefinition[] = [];

  // Match ENTITY ... END_ENTITY blocks
  const entityRegex = /ENTITY\s+(\w+)([\s\S]*?)END_ENTITY\s*;/g;

  let match;
  while ((match = entityRegex.exec(content)) !== null) {
    const entityName = match[1];
    const entityBody = match[2];

    entities.push(parseEntity(entityName, entityBody));
  }

  return entities;
}

/**
 * Parse a single ENTITY definition
 */
function parseEntity(name: string, body: string): EntityDefinition {
  const entity: EntityDefinition = {
    name,
    isAbstract: false,
    attributes: [],
  };

  // Check if abstract
  if (body.includes('ABSTRACT')) {
    entity.isAbstract = true;
  }

  // Parse SUBTYPE OF
  const subtypeMatch = body.match(/SUBTYPE\s+OF\s+\((\w+)\)/);
  if (subtypeMatch) {
    entity.supertype = subtypeMatch[1];
  }

  // Parse SUPERTYPE OF (list of subtypes)
  const supertypeMatch = body.match(/SUPERTYPE\s+OF\s+\(ONEOF\s*\(([\s\S]*?)\)\)/);
  if (supertypeMatch) {
    entity.supertypeOf = supertypeMatch[1]
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // Extract just the attributes section (before WHERE, DERIVE, INVERSE, UNIQUE)
  let attributesSection = body;

  // Find where attributes section ends
  // Match only section-level keywords at line start (not inside attribute types, e.g. "OF UNIQUE")
  const sectionMatches = [
    body.match(/^\s*WHERE\b/m),
    body.match(/^\s*DERIVE\b/m),
    body.match(/^\s*INVERSE\b/m),
    body.match(/^\s*UNIQUE\b/m),
  ].filter(m => m !== null) as RegExpMatchArray[];

  if (sectionMatches.length > 0) {
    // Find the earliest match
    const earliestIndex = Math.min(...sectionMatches.map(m => m.index!));
    attributesSection = body.substring(0, earliestIndex);
  }

  // Parse attributes (lines with : between name and type)
  // Format: AttributeName : [OPTIONAL] Type;
  const attributeRegex = /^\s*(\w+)\s*:\s*(OPTIONAL\s+)?([\s\S]*?);/gm;

  let attrMatch;
  while ((attrMatch = attributeRegex.exec(attributesSection)) !== null) {
    const attrName = attrMatch[1];
    const optional = !!attrMatch[2];
    const typeStr = attrMatch[3].trim();

    entity.attributes.push(parseAttribute(attrName, typeStr, optional));
  }

  // Parse WHERE rules
  const whereMatch = body.match(/WHERE([\s\S]*?)(?:UNIQUE|DERIVE|INVERSE|END_ENTITY|$)/);
  if (whereMatch) {
    entity.whereRules = whereMatch[1]
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  // Parse UNIQUE rules
  const uniqueMatch = body.match(/UNIQUE([\s\S]*?)(?:WHERE|DERIVE|INVERSE|END_ENTITY|$)/);
  if (uniqueMatch) {
    entity.uniqueRules = uniqueMatch[1]
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  return entity;
}

/**
 * Parse an attribute definition
 */
function parseAttribute(name: string, typeStr: string, optional: boolean): AttributeDefinition {
  const attr: AttributeDefinition = {
    name,
    type: '',
    optional,
    isArray: false,
    isList: false,
    isSet: false,
  };

  // Check for aggregation types: LIST, ARRAY, SET
  // Match patterns like: LIST [1:?] OF Type, ARRAY [1:3] OF REAL, SET [0:?] OF Label
  // Also handle nested collections: LIST [2:?] OF LIST [2:?] OF IfcCartesianPoint
  if (typeStr.includes('LIST')) {
    attr.isList = true;
    const listMatch = typeStr.match(/LIST\s+\[(\d+|\?):(\d+|\?)\]\s+OF\s+(.*)/);
    if (listMatch) {
      attr.arrayBounds = [
        listMatch[1] === '?' ? Infinity : parseInt(listMatch[1]),
        listMatch[2] === '?' ? Infinity : parseInt(listMatch[2])
      ];
      const innerType = listMatch[3].trim();
      // Recursively parse nested collection
      attr.type = parseNestedCollection(innerType);
    } else {
      // Fallback if regex doesn't match
      attr.type = typeStr.replace(/LIST\s+\[.*?\]\s+OF\s+/, '').trim();
    }
  } else if (typeStr.includes('ARRAY')) {
    attr.isArray = true;
    const arrayMatch = typeStr.match(/ARRAY\s+\[(\d+|\?):(\d+|\?)\]\s+OF\s+(.*)/);
    if (arrayMatch) {
      attr.arrayBounds = [
        arrayMatch[1] === '?' ? Infinity : parseInt(arrayMatch[1]),
        arrayMatch[2] === '?' ? Infinity : parseInt(arrayMatch[2])
      ];
      const innerType = arrayMatch[3].trim();
      // Recursively parse nested collection
      attr.type = parseNestedCollection(innerType);
    } else {
      // Fallback if regex doesn't match
      attr.type = typeStr.replace(/ARRAY\s+\[.*?\]\s+OF\s+/, '').trim();
    }
  } else if (typeStr.includes('SET')) {
    attr.isSet = true;
    const setMatch = typeStr.match(/SET\s+\[(\d+|\?):(\d+|\?)\]\s+OF\s+(.*)/);
    if (setMatch) {
      attr.arrayBounds = [
        setMatch[1] === '?' ? Infinity : parseInt(setMatch[1]),
        setMatch[2] === '?' ? Infinity : parseInt(setMatch[2])
      ];
      const innerType = setMatch[3].trim();
      // Recursively parse nested collection
      attr.type = parseNestedCollection(innerType);
    } else {
      // Fallback if regex doesn't match
      attr.type = typeStr.replace(/SET\s+\[.*?\]\s+OF\s+/, '').trim();
    }
  } else {
    attr.type = typeStr;
  }

  return attr;
}

/**
 * Parse nested collection types
 * e.g., "LIST [2:?] OF IfcCartesianPoint" -> "IfcCartesianPoint[]"
 */
function parseNestedCollection(typeStr: string): string {
  // Check if this is another collection
  if (typeStr.match(/^(LIST|ARRAY|SET)\s+\[/)) {
    // Match: LIST|ARRAY|SET [min:max] OF <innerType>
    const match = typeStr.match(/^(?:LIST|ARRAY|SET)\s+\[(?:\d+|\?):(?:\d+|\?)\]\s+OF\s+(.*)/);
    if (match) {
      const innerType = match[1].trim();
      // Recursively parse and wrap in array
      return `${parseNestedCollection(innerType)}[]`;
    }
  }

  // Base case: return the type as-is
  return typeStr;
}

/**
 * Parse TYPE definitions (non-enum, non-select)
 */
function parseTypes(content: string): TypeDefinition[] {
  const types: TypeDefinition[] = [];

  // Match TYPE ... END_TYPE blocks (exclude ENUMERATION and SELECT)
  const typeRegex = /TYPE\s+(\w+)\s*=\s*(?!ENUMERATION|SELECT)([\s\S]*?)END_TYPE\s*;/g;

  let match;
  while ((match = typeRegex.exec(content)) !== null) {
    const typeName = match[1];
    const typeBody = match[2].trim();

    // Extract underlying type (first word before semicolon or WHERE)
    const underlyingMatch = typeBody.match(/^([^;]*?)(?:;|WHERE|$)/);
    const underlyingType = underlyingMatch ? underlyingMatch[1].trim() : 'STRING';

    // Parse WHERE rules if present
    const whereMatch = typeBody.match(/WHERE([\s\S]*?)$/);
    const whereRules = whereMatch
      ? whereMatch[1]
          .split(';')
          .map(s => s.trim())
          .filter(s => s.length > 0)
      : undefined;

    types.push({
      name: typeName,
      underlyingType,
      whereRules,
    });
  }

  return types;
}

/**
 * Parse ENUMERATION types
 */
function parseEnums(content: string): EnumDefinition[] {
  const enums: EnumDefinition[] = [];

  // Match TYPE ... = ENUMERATION OF (...) blocks
  const enumRegex = /TYPE\s+(\w+)\s*=\s*ENUMERATION\s+OF\s*\(([\s\S]*?)\)\s*;[\s\S]*?END_TYPE\s*;/g;

  let match;
  while ((match = enumRegex.exec(content)) !== null) {
    const enumName = match[1];
    const valuesStr = match[2];

    // Parse enum values (comma-separated, may have line breaks)
    const values = valuesStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    enums.push({
      name: enumName,
      values,
    });
  }

  return enums;
}

/**
 * Parse SELECT types (union types)
 */
function parseSelects(content: string): SelectDefinition[] {
  const selects: SelectDefinition[] = [];

  // Match TYPE ... = SELECT (...) blocks
  const selectRegex = /TYPE\s+(\w+)\s*=\s*SELECT\s*\(([\s\S]*?)\)\s*;[\s\S]*?END_TYPE\s*;/g;

  let match;
  while ((match = selectRegex.exec(content)) !== null) {
    const selectName = match[1];
    const typesStr = match[2];

    // Parse select types (comma-separated, may have line breaks)
    const types = typesStr
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    selects.push({
      name: selectName,
      types,
    });
  }

  return selects;
}

/**
 * Get all attributes for an entity including inherited attributes
 */
export function getAllAttributes(
  entity: EntityDefinition,
  schema: ExpressSchema
): AttributeDefinition[] {
  // Collect attributes by walking up the inheritance chain,
  // then reverse to get STEP order (parent-first / root → leaf)
  const levels: AttributeDefinition[][] = [];

  // Guard against cyclic SUBTYPE OF chains in malformed schemas
  const seen = new Set<string>();
  let current: EntityDefinition | undefined = entity;
  while (current && !seen.has(current.name)) {
    seen.add(current.name);

    if (current.attributes.length > 0) {
      levels.push(current.attributes);
    }

    // Move to parent
    if (current.supertype) {
      current = schema.entities.find(e => e.name === current!.supertype);
    } else {
      current = undefined;
    }
  }

  // Reverse: root attributes first (STEP positional order)
  const attributes: AttributeDefinition[] = [];
  for (let i = levels.length - 1; i >= 0; i--) {
    attributes.push(...levels[i]);
  }

  return attributes;
}

/**
 * Get inheritance chain for an entity (from root to entity)
 */
export function getInheritanceChain(
  entity: EntityDefinition,
  schema: ExpressSchema
): string[] {
  const chain: string[] = [];

  // Guard against cyclic SUBTYPE OF chains in malformed schemas
  const seen = new Set<string>();
  let current: EntityDefinition | undefined = entity;
  while (current && !seen.has(current.name)) {
    seen.add(current.name);
    chain.unshift(current.name);  // Add to front

    if (current.supertype) {
      current = schema.entities.find(e => e.name === current!.supertype);
    } else {
      current = undefined;
    }
  }

  return chain;
}
