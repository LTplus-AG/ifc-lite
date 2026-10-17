/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-attribute flag bytes for the generated `IfcType::attribute_flags()`.
 *
 * One byte per attribute, parallel to `attribute_names()`:
 *
 *   bits 0-3  value kind (the KIND_* codes below; mirrored by
 *             `AttrKind` in rust/core/src/attribute_slot.rs)
 *   bit  4    AGGREGATE: the value may be written as a STEP list
 *   bit  5    OPTIONAL: the EXPRESS declaration says OPTIONAL
 *
 * The kind is resolved through defined types and selects, recursively:
 * an entity, or a select of entities only, is a Ref; an aggregate of those is
 * a RefList; any other aggregate is a List; REAL/NUMBER, INTEGER, STRING,
 * ENUMERATION, BOOLEAN/LOGICAL and BINARY map to their scalar kinds; a select
 * that mixes entities with value types is a Select. AGGREGATE is set for a
 * LIST/SET/ARRAY, for a defined type that is one, and for a select with such
 * an alternative (IfcPropertySetDefinitionSelect admits a SET of definitions
 * written inline as `(#20,#21)`).
 *
 * A name that resolves to nothing is a generation error, never a silent
 * default: a wrong flag reads as a wrong attribute at runtime.
 */

import type { AttributeDefinition, ExpressSchema } from './express-parser.js';

/** Mirrors `AttrKind` in rust/core/src/attribute_slot.rs. */
export const KIND = {
  Ref: 0,
  RefList: 1,
  List: 2,
  Real: 3,
  Int: 4,
  Text: 5,
  Enum: 6,
  Logical: 7,
  Binary: 8,
  Select: 9,
} as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export const FLAG_AGGREGATE = 0x10;
export const FLAG_OPTIONAL = 0x20;

interface Resolved {
  kind: Kind;
  aggregate: boolean;
}

const AGGREGATE_TYPE = /^(?:LIST|ARRAY|SET)\s*(?:\[[^\]]*\])?\s+OF\s+(?:OPTIONAL\s+)?(?:UNIQUE\s+)?([\s\S]*)$/;

/** Resolves EXPRESS type names against one schema. */
export class AttributeKindResolver {
  private readonly entities: Set<string>;
  private readonly types = new Map<string, string>();
  private readonly enums: Set<string>;
  private readonly selects = new Map<string, readonly string[]>();
  private readonly memo = new Map<string, Resolved>();

  constructor(schema: ExpressSchema) {
    this.entities = new Set(schema.entities.map((e) => e.name.toLowerCase()));
    for (const t of schema.types) this.types.set(t.name.toLowerCase(), t.underlyingType);
    this.enums = new Set(schema.enums.map((e) => e.name.toLowerCase()));
    for (const s of schema.selects) this.selects.set(s.name.toLowerCase(), s.types);
  }

  /** The flag byte for one attribute. */
  flagByte(attribute: AttributeDefinition): number {
    const { kind, aggregate } = this.attribute(attribute);
    return kind | (aggregate ? FLAG_AGGREGATE : 0) | (attribute.optional ? FLAG_OPTIONAL : 0);
  }

  private attribute(attribute: AttributeDefinition): Resolved {
    if (!(attribute.isList || attribute.isArray || attribute.isSet)) {
      return this.resolve(attribute.type, new Set());
    }
    // The parser keeps nested aggregates as "X[]"; those are never RefList.
    if (attribute.type.endsWith('[]')) return { kind: KIND.List, aggregate: true };
    return { kind: this.aggregateKind(this.resolve(attribute.type, new Set())), aggregate: true };
  }

  private aggregateKind(element: Resolved): Kind {
    return element.kind === KIND.Ref && !element.aggregate ? KIND.RefList : KIND.List;
  }

  private resolve(rawName: string, visiting: Set<string>): Resolved {
    const name = rawName.trim();
    const aggregateElement = name.match(AGGREGATE_TYPE);
    if (aggregateElement) {
      return { kind: this.aggregateKind(this.resolve(aggregateElement[1], visiting)), aggregate: true };
    }
    const base = name.toUpperCase().match(/^(REAL|NUMBER|INTEGER|STRING|BOOLEAN|LOGICAL|BINARY)\b/);
    if (base) return { kind: BASE_KIND[base[1]], aggregate: false };

    const key = name.toLowerCase();
    const cached = this.memo.get(key);
    if (cached) return cached;
    if (visiting.has(key)) throw new Error(`cyclic EXPRESS type definition at ${name}`);
    visiting.add(key);

    let result: Resolved;
    if (this.entities.has(key)) {
      result = { kind: KIND.Ref, aggregate: false };
    } else if (this.enums.has(key)) {
      result = { kind: KIND.Enum, aggregate: false };
    } else if (this.selects.has(key)) {
      const members = this.selects.get(key)!.map((member) => this.resolve(member, visiting));
      const refsOnly = members.every((m) => m.kind === KIND.Ref && !m.aggregate);
      result = {
        kind: refsOnly ? KIND.Ref : KIND.Select,
        aggregate: members.some((m) => m.aggregate),
      };
    } else if (this.types.has(key)) {
      result = this.resolve(this.types.get(key)!, visiting);
    } else {
      throw new Error(`cannot classify EXPRESS type "${name}"`);
    }
    visiting.delete(key);
    this.memo.set(key, result);
    return result;
  }
}

const BASE_KIND: Record<string, Kind> = {
  REAL: KIND.Real,
  NUMBER: KIND.Real,
  INTEGER: KIND.Int,
  STRING: KIND.Text,
  BOOLEAN: KIND.Logical,
  LOGICAL: KIND.Logical,
  BINARY: KIND.Binary,
};
