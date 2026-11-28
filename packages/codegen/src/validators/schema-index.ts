/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Case-insensitive symbol tables over a parsed EXPRESS schema (identifiers are case-insensitive in EXPRESS). */

import type { EntityDecl, ExpressRuleSchema, FunctionDecl, TypeDecl } from '../express/ast.js';

export type AttributeKind = 'explicit' | 'derived' | 'inverse';

export class SchemaIndex {
  readonly unsupportedBounds = new Set<string>();
  readonly entities = new Map<string, EntityDecl>();
  readonly types = new Map<string, TypeDecl>();
  readonly functions = new Map<string, FunctionDecl>();
  /** Enumeration item (upper) -> enumeration type names that declare it. */
  readonly enumItems = new Map<string, string[]>();
  /** Every attribute name (upper) declared anywhere, for typo detection. */
  readonly attributeNames = new Set<string>();
  private readonly attributeCache = new Map<string, Map<string, AttributeKind>>();
  /** Schema qualifier TYPEOF results carry, as the rules spell it (`IFC4`, not the file's `IFC4_ADD2_TC1`). */
  typePrefix: string;

  constructor(readonly schema: ExpressRuleSchema) {
    // IFC4 ADD2 TC1 declares IFC4_ADD2_TC1 but uses IFC4 in its type names.
    this.typePrefix = schema.name.toUpperCase() === 'IFC4_ADD2_TC1' ? 'IFC4' : schema.name.toUpperCase();
    for (const e of schema.entities) {
      this.entities.set(e.name.toUpperCase(), e);
      for (const a of [...e.explicit, ...e.derived, ...e.inverse]) this.attributeNames.add(a.name.toUpperCase());
    }
    for (const t of schema.types) this.types.set(t.name.toUpperCase(), t);
    const domains = new Map<string, string[]>();
    for (const t of schema.types) {
      const spec = t.spec;
      if (spec.k !== 'enumeration' && spec.k !== 'select') continue;
      const parts = [spec.items];
      const seen = new Set([t.name.toUpperCase()]);
      let base = spec.basedOn;
      while (base) {
        const parent = this.type(base);
        if (!parent || parent.spec.k !== spec.k || seen.has(base.toUpperCase())) {
          throw new Error(`Invalid ${spec.k} BASED_ON chain for ${t.name} at ${base}`);
        }
        seen.add(base.toUpperCase());
        parts.unshift(parent.spec.items);
        if (parent.spec.extensible) {
          const members = domains.get(parent.name) ?? [];
          members.push(...spec.items);
          domains.set(parent.name, members);
        }
        base = parent.spec.basedOn;
      }
      domains.set(t.name, [...parts.flat(), ...(domains.get(t.name) ?? [])]);
    }
    for (const t of schema.types) {
      if (t.spec.k === 'enumeration' || t.spec.k === 'select') t.spec.items = [...new Set(domains.get(t.name))];
      if (t.spec.k === 'enumeration') {
        for (const item of t.spec.items) {
          const list = this.enumItems.get(item.toUpperCase()) ?? [];
          list.push(t.name);
          this.enumItems.set(item.toUpperCase(), list);
        }
      }
    }
    for (const f of schema.functions) this.functions.set(f.name.toUpperCase(), f);
  }

  entity(name: string): EntityDecl | undefined {
    return this.entities.get(name.toUpperCase());
  }

  type(name: string): TypeDecl | undefined {
    return this.types.get(name.toUpperCase());
  }

  function(name: string): FunctionDecl | undefined {
    return this.functions.get(name.toUpperCase());
  }

  canonical(name: string): string | undefined {
    return this.entity(name)?.name ?? this.type(name)?.name ?? this.function(name)?.name;
  }

  /** Supertype chain from the root down to `entity`. */
  chain(entity: EntityDecl): EntityDecl[] {
    const out: EntityDecl[] = [];
    const seen = new Set<string>();
    const visit = (e: EntityDecl) => {
      if (seen.has(e.name)) return;
      seen.add(e.name);
      for (const s of e.supertypes) {
        const parent = this.entity(s);
        if (parent) visit(parent);
      }
      out.push(e);
    };
    visit(entity);
    return out;
  }

  /** Attributes visible on `entity` (own and inherited), upper name -> kind, the most specific declaration winning. */
  attributesOf(entity: EntityDecl): Map<string, AttributeKind> {
    let map = this.attributeCache.get(entity.name);
    if (map) return map;
    map = new Map();
    for (const level of this.chain(entity)) {
      for (const a of level.explicit) map.set(a.name.toUpperCase(), 'explicit');
      for (const a of level.derived) {
        map.set(a.name.toUpperCase(), 'derived');
        if (a.redeclares) map.set(a.redeclares.attribute.toUpperCase(), 'derived');
      }
      for (const a of level.inverse) map.set(a.name.toUpperCase(), 'inverse');
    }
    this.attributeCache.set(entity.name, map);
    return map;
  }

  isEnumeration(name: string): boolean {
    return this.type(name)?.spec.k === 'enumeration';
  }
}
