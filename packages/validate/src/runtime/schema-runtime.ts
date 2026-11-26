/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Resolves the emitted schema tables into lookups the validator runs on. */

import type {
  AttributeMeta, CompiledRule, CompiledRules, DerivedFn, EntityMeta, EntityRuleFn, InverseMeta, SchemaMeta, TypeMeta, TypeRuleFn,
} from './schema-meta.js';

export interface ResolvedAttribute extends AttributeMeta {
  declaredBy: string;
  /** True when this entity (or a supertype of it) redeclares the attribute as DERIVE. */
  derived: boolean;
}

export type AttributeSlot =
  | { k: 'explicit'; index: number; attribute: ResolvedAttribute }
  | { k: 'derived'; fn: DerivedFn | undefined; owner: string }
  | { k: 'inverse'; inverse: InverseMeta };

export interface ResolvedEntityRule {
  declaredBy: string;
  rule: CompiledRule<EntityRuleFn>;
}

export class ResolvedEntity {
  readonly upper: string;
  supertype?: ResolvedEntity;
  readonly subtypes: ResolvedEntity[] = [];
  chain: ResolvedEntity[] = [];
  attributes: ResolvedAttribute[] = [];
  inverses: InverseMeta[] = [];
  rules: ResolvedEntityRule[] = [];
  readonly slots = new Map<string, AttributeSlot>();
  readonly ancestors = new Set<string>();
  typeofNames: string[] = [];
  private descendantCache?: ResolvedEntity[];

  constructor(readonly meta: EntityMeta) {
    this.upper = meta.name.toUpperCase();
  }

  get name(): string {
    return this.meta.name;
  }

  isA(upperName: string): boolean {
    return this.ancestors.has(upperName);
  }

  /** This entity and every subtype, depth first. */
  descendants(): ResolvedEntity[] {
    if (!this.descendantCache) {
      const out: ResolvedEntity[] = [];
      const stack: ResolvedEntity[] = [this];
      while (stack.length) {
        const e = stack.pop()!;
        out.push(e);
        stack.push(...e.subtypes);
      }
      this.descendantCache = out;
    }
    return this.descendantCache;
  }
}

export interface ResolvedTypeRule {
  declaredBy: string;
  rule: CompiledRule<TypeRuleFn>;
}

export class SchemaRuntime {
  readonly name: string;
  readonly upperName: string;
  readonly typePrefix: string;
  readonly entities = new Map<string, ResolvedEntity>();
  readonly types = new Map<string, TypeMeta>();
  /** Type rules per defined type, including those inherited from the type it is based on. */
  readonly typeRules = new Map<string, ResolvedTypeRule[]>();
  private readonly selectLeaves = new Map<string, Set<string>>();

  constructor(readonly meta: SchemaMeta, readonly rules: CompiledRules) {
    this.name = meta.name;
    this.upperName = meta.name.toUpperCase();
    this.typePrefix = (meta.typePrefix ?? meta.name).toUpperCase();
    for (const t of meta.types) this.types.set(t.name.toUpperCase(), t);
    for (const e of meta.entities) this.entities.set(e.name.toUpperCase(), new ResolvedEntity(e));
    for (const e of this.entities.values()) {
      const parent = e.meta.supertype ? this.entities.get(e.meta.supertype.toUpperCase()) : undefined;
      if (parent) {
        e.supertype = parent;
        parent.subtypes.push(e);
      }
    }
    for (const e of this.entities.values()) this.resolveEntity(e);
    for (const t of meta.types) if (t.kind === 'defined') this.typeRules.set(t.name.toUpperCase(), this.collectTypeRules(t.name));
  }

  entity(name: string): ResolvedEntity | undefined {
    return this.entities.get(name.toUpperCase());
  }

  type(name: string): TypeMeta | undefined {
    return this.types.get(name.toUpperCase());
  }

  /** Canonical spelling of an entity or type name, as declared. */
  canonicalName(name: string): string | undefined {
    const upper = name.toUpperCase();
    return this.entities.get(upper)?.name ?? this.types.get(upper)?.name;
  }

  /** Entity and type names a value of `select` may carry, expanding nested selects and entity subtypes. */
  selectMembers(select: string): Set<string> {
    const key = select.toUpperCase();
    let leaves = this.selectLeaves.get(key);
    if (leaves) return leaves;
    leaves = new Set<string>();
    const visit = (name: string, seen: Set<string>) => {
      const upper = name.toUpperCase();
      if (seen.has(upper)) return;
      seen.add(upper);
      const t = this.types.get(upper);
      if (t?.kind === 'select') {
        for (const item of t.items) visit(item, seen);
        return;
      }
      const e = this.entities.get(upper);
      if (e) for (const d of e.descendants()) leaves!.add(d.upper);
      else leaves!.add(upper);
    };
    visit(select, new Set());
    this.selectLeaves.set(key, leaves);
    return leaves;
  }

  private collectTypeRules(name: string): ResolvedTypeRule[] {
    const out: ResolvedTypeRule[] = [];
    const seen = new Set<string>();
    let current: TypeMeta | undefined = this.type(name);
    while (current && current.kind === 'defined' && !seen.has(current.name)) {
      seen.add(current.name);
      for (const rule of this.rules.type[current.name] ?? []) out.push({ declaredBy: current.name, rule });
      current = current.underlying.k === 'named' ? this.type(current.underlying.name) : undefined;
    }
    return out;
  }

  private resolveEntity(e: ResolvedEntity): void {
    const chain: ResolvedEntity[] = [];
    const seen = new Set<string>();
    for (let c: ResolvedEntity | undefined = e; c && !seen.has(c.upper); c = c.supertype) {
      seen.add(c.upper);
      chain.unshift(c);
    }
    e.chain = chain;
    const derivedHere = new Set<string>();
    const retyped = new Map<string, AttributeMeta>();
    for (const level of chain) {
      for (const name of level.meta.derivedRedeclarations ?? []) derivedHere.add(name.toUpperCase());
      for (const [name, attr] of Object.entries(level.meta.retyped ?? {})) retyped.set(name.toUpperCase(), attr);
    }
    for (const level of chain) {
      e.ancestors.add(level.upper);
      for (const attr of level.meta.attributes) {
        const upper = attr.name.toUpperCase();
        const narrowed = retyped.get(upper);
        const resolved: ResolvedAttribute = {
          ...(narrowed ?? attr), name: attr.name, declaredBy: level.name, derived: derivedHere.has(upper),
        };
        e.slots.set(upper, { k: 'explicit', index: e.attributes.length, attribute: resolved });
        e.attributes.push(resolved);
      }
      for (const inv of level.meta.inverse ?? []) {
        e.inverses = e.inverses.filter((x) => x.name.toUpperCase() !== inv.name.toUpperCase());
        e.inverses.push(inv);
        e.slots.set(inv.name.toUpperCase(), { k: 'inverse', inverse: inv });
      }
      for (const rule of this.rules.entity[level.name] ?? []) e.rules.push({ declaredBy: level.name, rule });
    }
    for (const level of chain) {
      for (const name of [...(level.meta.derived ?? []), ...(level.meta.derivedRedeclarations ?? [])]) {
        e.slots.set(name.toUpperCase(), { k: 'derived', fn: this.rules.derived[`${level.name}.${name}`], owner: level.name });
      }
    }
    e.typeofNames = chain.map((c) => `${this.typePrefix}.${c.upper}`);
  }
}
