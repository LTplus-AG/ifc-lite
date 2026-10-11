/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Insert a bSDD class as classification and/or entity facets (05-bsdd.md
 * §2.1, IDS-070). The picker resolves a class, `snapshotBsddClass` keeps
 * what the insert needs, and `bsddInsertOp` builds the `bulk.fromBsddClass`
 * op that the host checks with the gate and commits: the document is only
 * ever changed through that op.
 */

import type { IFCVersion } from '@ifc-lite/ids';
import type { Section } from '../document/types.js';
import type { GateContext } from '../gate/context.js';
import type {
  BsddClassSnapshot,
  BsddEntityRef,
  BsddNewSpec,
  BsddPropertySelection,
  BsddPropertySnapshot,
  BulkFromBsddClassOp,
} from '../ops/types.js';
import { uuidv7, type Uuid } from '../uuid.js';
import type { BsddClass, BsddClassProperty } from './types.js';

const ALL_VERSIONS: readonly IFCVersion[] = ['IFC4X3_ADD2', 'IFC4', 'IFC2X3'];

/**
 * Split a related-entity name as bSDD publishes it. `IfcWall` is an entity;
 * `IfcWallSOLIDWALL` is `IfcWall` with predefined type `SOLIDWALL` when the
 * schema confirms both. Without schema tables, or when nothing matches, the
 * name is kept whole (the gate then reports it).
 */
export function splitRelatedEntity(name: string, gate?: GateContext, versions: readonly IFCVersion[] = ALL_VERSIONS): BsddEntityRef {
  if (!gate) return { entity: name };
  const tables = versions.map((v) => gate.tables[v]);
  const exact = tables.map((t) => t.entities.get(name.toUpperCase())).find((e) => !!e);
  if (exact) return { entity: exact.name };
  // Longest PascalCase prefix whose remainder is an UPPER-case predefined type of it.
  for (let cut = name.length - 1; cut > 3; cut--) {
    const head = name.slice(0, cut);
    const tail = name.slice(cut);
    if (!/^[A-Z][A-Z0-9_]*$/.test(tail) || !/[a-z0-9]$/.test(head)) continue;
    for (const t of tables) {
      const e = t.entities.get(head.toUpperCase());
      if (e?.predefinedTypes.some((p) => p.toUpperCase() === tail)) return { entity: e.name, predefinedType: tail };
    }
  }
  return { entity: name };
}

/** EXPRESS data type of a standard property (`Pset_WallCommon.IsExternal` → `IFCBOOLEAN`), from the first version that has it. */
export function standardDataType(pset: string, name: string, gate: GateContext, versions: readonly IFCVersion[] = ALL_VERSIONS): string | undefined {
  for (const v of versions) {
    const prop = gate.tables[v].psets.get(pset)?.properties.find((p) => p.name === name);
    const type = prop?.dataType ?? (prop?.kind === 'enumeration' ? 'IfcLabel' : undefined);
    if (type) return type.toUpperCase();
  }
  return undefined;
}

/** What the mapping table needs of a class property. */
export function snapshotBsddProperty(p: BsddClassProperty, gate?: GateContext, versions?: readonly IFCVersion[]): BsddPropertySnapshot {
  const out: BsddPropertySnapshot = { code: p.code };
  if (p.name !== p.code) out.name = p.name;
  for (const key of ['uri', 'propertySet', 'dataType', 'propertyValueKind', 'dimension', 'pattern'] as const) {
    if (p[key]) out[key] = p[key];
  }
  for (const key of ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const) {
    if (p[key] !== undefined) out[key] = p[key];
  }
  if (p.units?.length) out.units = [...p.units];
  if (p.allowedValues?.length) out.allowedValues = p.allowedValues.map((v) => ({ code: v.code, value: v.value }));
  if (p.isRequired !== undefined) out.isRequired = p.isRequired;
  const std = gate && p.propertySet ? standardDataType(p.propertySet, p.code, gate, versions) : undefined;
  if (std) out.standardDataType = std;
  return out;
}

/** What `bulk.fromBsddClass` carries of a class. Pass `properties` to carry other (e.g. inherited) properties. */
export function snapshotBsddClass(
  cls: BsddClass,
  options: { dictionaryName: string; gate?: GateContext; versions?: readonly IFCVersion[]; properties?: readonly BsddClassProperty[] },
): BsddClassSnapshot {
  const refs: BsddEntityRef[] = [];
  for (const name of cls.relatedIfcEntityNames) {
    const ref = splitRelatedEntity(name, options.gate, options.versions);
    if (!refs.some((r) => r.entity === ref.entity && r.predefinedType === ref.predefinedType)) refs.push(ref);
  }
  return {
    uri: cls.uri,
    code: cls.code,
    name: cls.name,
    dictionaryUri: cls.dictionaryUri,
    dictionaryName: options.dictionaryName,
    ...(refs.length ? { relatedIfcEntities: refs } : {}),
    properties: (options.properties ?? cls.properties).map((p) => snapshotBsddProperty(p, options.gate, options.versions)),
  };
}

/** The entity choices a picker offers for a class (several related entities: pick one or keep all as an enumeration). */
export function entityChoices(snapshot: BsddClassSnapshot): string[] {
  const out: string[] = [];
  for (const r of snapshot.relatedIfcEntities ?? []) if (!out.includes(r.entity)) out.push(r.entity);
  return out;
}

/** Which facets to insert; `none` adds only the selected properties. */
export type BsddInsertMode = 'classification' | 'entity' | 'both' | 'none';

export interface BsddInsertRequest {
  classes: BsddClassSnapshot[];
  /** An existing specification, or a new one. */
  target: { specId: Uuid } | { newSpec: BsddNewSpec };
  mode: BsddInsertMode;
  /** Where the facets go. Default `applicability` ("applies to IfcWall classified as X"). */
  section?: Section;
  /** Restrict the entity facet to these related entities. */
  entities?: string[];
  /** Property requirements to add through the mapping table. */
  properties?: BsddPropertySelection;
  opId?: Uuid;
}

/** The `bulk.fromBsddClass` op for an insert from the picker. */
export function bsddInsertOp(request: BsddInsertRequest): BulkFromBsddClassOp {
  const section = request.section ?? 'applicability';
  const payload: BulkFromBsddClassOp['payload'] = { classes: request.classes, target: request.target };
  if (request.mode === 'entity' || request.mode === 'both') payload.entity = { section, ...(request.entities?.length ? { entities: request.entities } : {}) };
  if (request.mode === 'classification' || request.mode === 'both') payload.classification = { section };
  if (request.properties?.select.length) payload.properties = request.properties;
  return { kind: 'bulk.fromBsddClass', opId: request.opId ?? uuidv7(), payload };
}
