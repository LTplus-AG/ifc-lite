/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gate's view of the per-version IFC schema tables in `@ifc-lite/data`.
 *
 * `@ifc-lite/data` exposes async lookups (so a future build can lazy-load
 * the tables); the gate runs on every keystroke and inside agent tool calls,
 * so `createGateContext()` loads the tables once and builds synchronous,
 * case-folded indexes. `checkOps` is then synchronous.
 */

import {
  getAttributes,
  getDataTypes,
  getEntities,
  getPropertySets,
  IFC_DATA_TYPES,
  type IfcDataTypeInfo,
  type IfcEntityInfo,
  type IfcPropertySetInfo,
  type IfcSchemaVersion,
} from '@ifc-lite/data';
import type { IFCVersion } from '@ifc-lite/ids';
import type { CustomPsetDecl } from '../document/types.js';

export interface VersionTables {
  readonly version: IfcSchemaVersion;
  /** UPPERCASE name → entity. EXPRESS defined types (IfcLabel, …) are excluded. */
  readonly entities: ReadonlyMap<string, IfcEntityInfo>;
  /** PascalCase entity names, for candidate ranking. */
  readonly entityNames: readonly string[];
  /** Exact name → property set (`Pset_*`, `Qto_*`). */
  readonly psets: ReadonlyMap<string, IfcPropertySetInfo>;
  readonly psetNames: readonly string[];
  /** Property name → names of the standard sets that define it. */
  readonly psetsByProperty: ReadonlyMap<string, readonly string[]>;
  /** UPPERCASE name → IFC data type. */
  readonly dataTypes: ReadonlyMap<string, IfcDataTypeInfo>;
  /** Every attribute name of the version (any entity). */
  readonly attributeNames: ReadonlySet<string>;
  /**
   * Whether the tables enumerate quantity sets. The upstream data only has
   * `Qto_*` rows for IFC4X3; for IFC2X3/IFC4 a `Qto_*` name cannot be
   * verified and is accepted (IDS-009 fills these tables).
   */
  readonly hasQuantitySets: boolean;
}

export interface GateContext {
  readonly tables: Readonly<Record<IfcSchemaVersion, VersionTables>>;
  /** Custom psets declared outside the document (e.g. an organisation library). */
  readonly custom: readonly CustomPsetDecl[];
}

const VERSIONS: readonly IfcSchemaVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2'];

const DEFINED_TYPE_NAMES = new Set(IFC_DATA_TYPES.map((t) => t.name.toUpperCase()));

async function loadVersion(version: IfcSchemaVersion): Promise<VersionTables> {
  const [entityList, psetList, dataTypeList, attributeList] = await Promise.all([
    getEntities(version),
    getPropertySets(version),
    getDataTypes(version),
    getAttributes(version),
  ]);
  const entities = new Map<string, IfcEntityInfo>();
  for (const e of entityList) {
    const upper = e.name.toUpperCase();
    if (!DEFINED_TYPE_NAMES.has(upper)) entities.set(upper, e);
  }
  const psets = new Map<string, IfcPropertySetInfo>();
  const psetsByProperty = new Map<string, string[]>();
  for (const p of psetList) {
    psets.set(p.name, p);
    for (const prop of p.properties) {
      const list = psetsByProperty.get(prop.name) ?? [];
      list.push(p.name);
      psetsByProperty.set(prop.name, list);
    }
  }
  return {
    version,
    entities,
    entityNames: [...entities.values()].map((e) => e.name),
    psets,
    psetNames: [...psets.keys()],
    psetsByProperty,
    dataTypes: new Map(dataTypeList.map((t) => [t.name.toUpperCase(), t])),
    attributeNames: new Set(attributeList.map((a) => a.name)),
    hasQuantitySets: psetList.some((p) => p.name.startsWith('Qto_')),
  };
}

let shared: Promise<Readonly<Record<IfcSchemaVersion, VersionTables>>> | undefined;

function loadAll(): Promise<Readonly<Record<IfcSchemaVersion, VersionTables>>> {
  shared ??= Promise.all(VERSIONS.map(loadVersion)).then(
    (list) => Object.fromEntries(list.map((t) => [t.version, t])) as Record<IfcSchemaVersion, VersionTables>,
  );
  return shared;
}

/** Load the schema tables (once per process) and build a gate context. */
export async function createGateContext(options: { custom?: readonly CustomPsetDecl[] } = {}): Promise<GateContext> {
  return { tables: await loadAll(), custom: options.custom ?? [] };
}

export function tablesFor(ctx: GateContext, version: IFCVersion): VersionTables {
  return ctx.tables[version];
}

/** The inheritance chain of `name` (itself first), or [] when unknown. */
export function inheritanceChain(tables: VersionTables, name: string): IfcEntityInfo[] {
  const chain: IfcEntityInfo[] = [];
  const seen = new Set<string>();
  let cursor = tables.entities.get(name.toUpperCase());
  while (cursor && !seen.has(cursor.name)) {
    chain.push(cursor);
    seen.add(cursor.name);
    cursor = cursor.parent ? tables.entities.get(cursor.parent.toUpperCase()) : undefined;
  }
  return chain;
}
