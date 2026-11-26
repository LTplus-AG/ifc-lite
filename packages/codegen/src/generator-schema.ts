/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseExpressRules } from './express/declaration-parser.js';
import type { Expr, TypeSpec, WhereRule } from './express/ast.js';

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

function rules(where: WhereRule[]): string[] | undefined {
  return where.length ? where.map(rule => `${rule.label}: ${rule.source}`) : undefined;
}

function bound(expr?: Expr): number | undefined {
  if (expr?.k === 'indeterminate') return Infinity;
  return expr?.k === 'num' ? expr.value : undefined;
}

function elementName(spec: TypeSpec): string {
  switch (spec.k) {
    case 'named': return spec.name;
    case 'simple': return spec.spelling ?? spec.name;
    case 'aggregate': return `${elementName(spec.of)}[]`;
    case 'generic': return spec.entity ? 'GENERIC_ENTITY' : 'GENERIC';
    case 'enumeration': return 'ENUMERATION';
    case 'select': return 'SELECT';
  }
}

/** Project the tokenised declarations onto the public generator schema. */
export function parseExpressSchema(content: string): ExpressSchema {
  const ast = parseExpressRules(content);
  return {
    name: ast.name,
    types: ast.types.map(t => ({ name: t.name, underlyingType: t.source, whereRules: rules(t.where) })),
    enums: ast.types.flatMap(t => t.spec.k === 'enumeration' ? [{ name: t.name, values: t.spec.items }] : []),
    selects: ast.types.flatMap(t => t.spec.k === 'select' ? [{ name: t.name, types: t.spec.items }] : []),
    entities: ast.entities.map(e => ({
      name: e.name, isAbstract: e.abstract, supertype: e.supertypes[0], supertypeOf: e.subtypeNames,
      attributes: e.explicit.filter(a => !a.redeclares).map(a => {
        const agg = a.type.k === 'aggregate' ? a.type : undefined;
        const low = bound(agg?.low), high = bound(agg?.high);
        const attr: AttributeDefinition = {
          name: a.name, optional: a.optional, type: elementName(agg?.of ?? a.type),
          isList: agg?.kind === 'LIST', isSet: agg?.kind === 'SET', isArray: agg?.kind === 'ARRAY',
        };
        if (low !== undefined && high !== undefined) attr.arrayBounds = [low, high];
        return attr;
      }),
      whereRules: rules(e.where),
      uniqueRules: e.unique.length ? e.unique.map(u => `${u.label}: ${u.attributes.map(a => a.entity ? `SELF\\${a.entity}.${a.name}` : a.name).join(', ')}`) : undefined,
    })),
  };
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
