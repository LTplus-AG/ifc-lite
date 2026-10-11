/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-aware picker options (IDS-033, IDS-034), read from the same per-version
 * tables the grounding gate checks against, so what a picker offers is what
 * the gate accepts. A specification may target several IFC versions; a name
 * is offered only when it exists in every one of them.
 */

import type { GateContext, VersionTables } from '@ifc-lite/ids-authoring';
import type { IFCVersion } from '@ifc-lite/ids';

export interface EntityOption {
  /** PascalCase name, e.g. `IfcWall`. */
  name: string;
  abstract: boolean;
  /** Supertypes, nearest first (`IfcBuiltElement`, `IfcElement`, …). */
  ancestors: string[];
  predefinedTypes: readonly string[];
}

export interface PsetOption {
  name: string;
  /** Applicable to one of the spec's applicability entities (or a supertype / companion type). */
  applicable: boolean;
  quantity: boolean;
}

export interface PropertyOption {
  name: string;
  dataType?: string;
  enumeration?: readonly string[];
}

function tablesOf(ctx: GateContext, versions: readonly IFCVersion[]): VersionTables[] {
  const list = versions.length ? versions : (['IFC4'] as const);
  return [...new Set(list)].map((v) => ctx.tables[v]);
}

/** Supertypes of `name` in `t`, nearest first; bounded by a visited set. */
export function ancestorsOf(t: VersionTables, name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([name.toUpperCase()]);
  let parent = t.entities.get(name.toUpperCase())?.parent;
  while (parent && !seen.has(parent.toUpperCase())) {
    seen.add(parent.toUpperCase());
    out.push(parent);
    parent = t.entities.get(parent.toUpperCase())?.parent;
  }
  return out;
}

/** Every entity of all `versions`, alphabetical, with its supertypes and abstract flag. */
export function entityOptions(ctx: GateContext, versions: readonly IFCVersion[]): EntityOption[] {
  const [first, ...rest] = tablesOf(ctx, versions);
  const out: EntityOption[] = [];
  for (const [upper, entity] of first.entities) {
    if (rest.some((t) => !t.entities.has(upper))) continue;
    out.push({ name: entity.name, abstract: entity.abstract, ancestors: ancestorsOf(first, entity.name), predefinedTypes: entity.predefinedTypes });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive lookup of one entity across `versions` (intersection). */
export function findEntity(ctx: GateContext, versions: readonly IFCVersion[], name: string): EntityOption | undefined {
  const upper = name.toUpperCase();
  const all = tablesOf(ctx, versions);
  if (all.some((t) => !t.entities.has(upper))) return undefined;
  const entity = all[0].entities.get(upper);
  if (!entity) return undefined;
  const predefined = all.slice(1).reduce<readonly string[]>(
    (acc, t) => acc.filter((p) => t.entities.get(upper)?.predefinedTypes.includes(p)), entity.predefinedTypes);
  return { name: entity.name, abstract: entity.abstract, ancestors: ancestorsOf(all[0], entity.name), predefinedTypes: predefined };
}

/** Attribute names an `attribute` facet may use: the entity's own and inherited ones, or every attribute when no entity is known. */
export function attributeOptions(ctx: GateContext, versions: readonly IFCVersion[], entityNames: readonly string[]): string[] {
  const all = tablesOf(ctx, versions);
  const known = entityNames.map((n) => all[0].entities.get(n.toUpperCase())).filter((e) => e !== undefined);
  if (!known.length) return [...all[0].attributeNames].filter((a) => all.every((t) => t.attributeNames.has(a))).sort();
  const names = new Set<string>();
  for (const entity of known) for (const a of entity.attributes) names.add(a);
  return [...names].sort();
}

function applicableTo(t: VersionTables, applicableEntities: readonly string[], entities: readonly string[]): boolean {
  if (!applicableEntities.length) return false;
  const targets = new Set<string>();
  for (const name of applicableEntities) {
    const upper = name.toUpperCase();
    targets.add(upper);
    const companion = t.entities.get(upper)?.typeEntity;
    if (companion) targets.add(companion.toUpperCase());
    else if (t.entities.has(`${upper}TYPE`)) targets.add(`${upper}TYPE`);
  }
  return entities.some((e) => [e, ...ancestorsOf(t, e)].some((n) => targets.has(n.toUpperCase())));
}

/**
 * Standard property and quantity sets of `versions`. With applicability
 * entities, `applicable` marks the sets defined for them; `showAll: false`
 * keeps only those (the default view of the picker).
 */
export function psetOptions(ctx: GateContext, versions: readonly IFCVersion[], entities: readonly string[], showAll: boolean): PsetOption[] {
  const [first, ...rest] = tablesOf(ctx, versions);
  const out: PsetOption[] = [];
  for (const [name, pset] of first.psets) {
    if (rest.some((t) => !t.psets.has(name))) continue;
    const applicable = entities.length > 0 && applicableTo(first, pset.applicableEntities, entities);
    if (!showAll && entities.length > 0 && !applicable) continue;
    out.push({ name, applicable, quantity: name.startsWith('Qto_') });
  }
  return out.sort((a, b) => Number(b.applicable) - Number(a.applicable) || a.name.localeCompare(b.name));
}

/** Properties of a standard set, with the data type the schema declares. */
export function propertyOptions(ctx: GateContext, versions: readonly IFCVersion[], psetName: string): PropertyOption[] {
  const pset = tablesOf(ctx, versions)[0].psets.get(psetName);
  if (!pset) return [];
  return pset.properties.map((p) => ({
    name: p.name,
    ...(p.dataType ? { dataType: p.dataType.toUpperCase() } : {}),
    ...(p.enumeration ? { enumeration: p.enumeration } : {}),
  }));
}

/** IFC data type names (upper case, as IDS writes them) valid in every version. */
export function dataTypeOptions(ctx: GateContext, versions: readonly IFCVersion[]): string[] {
  const [first, ...rest] = tablesOf(ctx, versions);
  return [...first.dataTypes.keys()].filter((n) => rest.every((t) => t.dataTypes.has(n))).sort();
}

/** The XSD base an IFC data type is stored as (`IFCLENGTHMEASURE` → `xs:double`). */
export function dataTypeBase(ctx: GateContext, versions: readonly IFCVersion[], dataType: string): string | undefined {
  return tablesOf(ctx, versions)[0].dataTypes.get(dataType.toUpperCase())?.backingType;
}

/** Whether `name` is a standard set in every version (else it must be declared as custom). */
export function isStandardPset(ctx: GateContext, versions: readonly IFCVersion[], name: string): boolean {
  return tablesOf(ctx, versions).every((t) => t.psets.has(name));
}
