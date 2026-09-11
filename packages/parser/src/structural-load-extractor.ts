/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural load and boundary-condition readers — the leaf resources an
 * activity's `AppliedLoad` and a connection's `AppliedCondition` point at.
 *
 * Both readers are **schema-derived**: they ask the generated registry for the
 * entity's attribute names in STEP positional order and emit every numeric
 * component under its exact EXPRESS name, rather than carrying a hand-written
 * table per `IfcStructuralLoadStatic` / `IfcBoundaryCondition` subtype. A
 * subtype the registry knows therefore reads correctly the day it appears in a
 * file, and `IfcStructuralLoadSingleForceWarping.WarpingMoment` needs no
 * separate case from `IfcStructuralLoadSingleForce.ForceX`.
 */

import type { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { getAttributeNames, normalizeIfcTypeName } from './ifc-schema.js';
import { asBoolean, asNumber, asString } from './structural-step-values.js';

/** Attributes that every load/condition carries from its supertype, not a component. */
const NAME_ATTR = 'Name';

/**
 * `IfcStructuralLoadConfiguration` positional attributes. Named here rather
 * than resolved by name because this is the one load whose components are
 * references and lists instead of measures.
 */
const LOAD_CONFIGURATION_ATTR = {
  Name: 0,
  Values: 1,
  Locations: 2,
} as const;

/**
 * One `IfcStructuralLoadOrResult` leaf — a force, displacement, temperature or
 * planar/linear force — reduced to its named numeric components.
 */
export interface StructuralLoadInfo {
  expressId: number;
  /** Canonical EXPRESS type name, e.g. `IfcStructuralLoadSingleForce`. */
  type: string;
  name?: string;
  /**
   * Numeric components keyed by their exact EXPRESS attribute name
   * (`ForceX`, `MomentZ`, `DisplacementY`, `DeltaTConstant`, …). Only
   * attributes the file actually carries a finite number for appear; an
   * omitted (`$`) optional is absent rather than zero, because zero is a
   * meaningful load value and conflating the two would invent data.
   */
  components: Record<string, number>;
  /**
   * Present only for `IfcStructuralLoadConfiguration`: the nested loads and
   * the parametric locations they apply at. `locations[i]` positions
   * `values[i]`; it is absent when the file omits the optional `Locations`.
   */
  configuration?: {
    values: StructuralLoadInfo[];
    locations?: number[][];
  };
}

/** An `IfcBoundaryCondition` leaf reduced to its named stiffness components. */
export interface BoundaryConditionInfo {
  expressId: number;
  /** Canonical EXPRESS type name, e.g. `IfcBoundaryNodeCondition`. */
  type: string;
  name?: string;
  /**
   * Stiffness components keyed by their exact EXPRESS attribute name
   * (`TranslationalStiffnessX`, `RotationalStiffnessZ`, …).
   *
   * The value is a number when the file gives a stiffness magnitude, and a
   * boolean when it uses the select's `IfcBoolean` branch — which is how a
   * fully fixed or fully free degree of freedom is written (`.T.` = fixed).
   * Collapsing the boolean branch to a number would report a rigid support as
   * stiffness 1.
   */
  components: Record<string, number | boolean>;
}

/**
 * Read the `Locations` attribute of an `IfcStructuralLoadConfiguration`: a
 * list of 1..2-element lists of `IfcLengthMeasure`.
 */
function readLocations(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: number[][] = [];
  for (const row of value) {
    if (!Array.isArray(row)) continue;
    const nums: number[] = [];
    for (const cell of row) {
      const n = asNumber(cell);
      if (n !== undefined) nums.push(n);
    }
    rows.push(nums);
  }
  return rows.length > 0 ? rows : undefined;
}

/** Longest chain of nested configurations followed before giving up. */
const MAX_LOAD_DEPTH = 4;
/** Ceiling on entities expanded by one top-level load read. */
const MAX_LOAD_NODES = 256;

/**
 * Read one `IfcStructuralLoad` entity by expressId, resolving an
 * `IfcStructuralLoadConfiguration` down through the loads its `Values` name.
 *
 * The `Values` edge is the only recursive one here, and it is
 * exporter-controlled, so it is bounded three ways — none of which is
 * redundant:
 *
 * - a **path-local** cycle set stops a configuration that reaches itself. It
 *   has to be path-local rather than shared across siblings, because `Values`
 *   is a LIST and may legitimately name one load twice; a shared set would
 *   drop the repeat and misalign `values[i]` against `locations[i]`.
 * - a **depth cap** bounds one chain's length, which the cycle set alone does
 *   not for a long acyclic chain.
 * - a **node budget** bounds total work. The first two still admit `k`
 *   children each recursing `k` deep, which is O(k^depth) — an abort turned
 *   into a hang, and a hang reports nothing.
 */
export function extractStructuralLoad(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): StructuralLoadInfo | undefined {
  return readLoad(extractor, store, expressId, new Set(), { remaining: MAX_LOAD_NODES }, 0);
}

function readLoad(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
  path: Set<number>,
  budget: { remaining: number },
  depth: number,
): StructuralLoadInfo | undefined {
  if (depth > MAX_LOAD_DEPTH || path.has(expressId) || budget.remaining <= 0) return undefined;
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;

  budget.remaining--;
  const type = normalizeIfcTypeName(entity.type);
  const attrs = entity.attributes || [];

  if (type.toUpperCase() === 'IFCSTRUCTURALLOADCONFIGURATION') {
    const nested: StructuralLoadInfo[] = [];
    const values = attrs[LOAD_CONFIGURATION_ATTR.Values];
    if (Array.isArray(values)) {
      // On this node's path only — removed again below so a sibling that
      // names the same load still reads it.
      path.add(expressId);
      for (const v of values) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) continue;
        const load = readLoad(extractor, store, v, path, budget, depth + 1);
        if (load) nested.push(load);
      }
      path.delete(expressId);
    }
    return {
      expressId,
      type,
      name: asString(attrs[LOAD_CONFIGURATION_ATTR.Name]),
      components: {},
      configuration: {
        values: nested,
        locations: readLocations(attrs[LOAD_CONFIGURATION_ATTR.Locations]),
      },
    };
  }

  return {
    expressId,
    type,
    name: asString(attrs[0]),
    components: readNumericComponents(type, attrs),
  };
}

/**
 * Every attribute the registry names for `type`, except the inherited `Name`,
 * that the record carries a finite number for.
 */
function readNumericComponents(type: string, attrs: unknown[]): Record<string, number> {
  const components: Record<string, number> = {};
  const names = getAttributeNames(type);
  for (let i = 0; i < names.length; i++) {
    const attrName = names[i];
    if (attrName === NAME_ATTR) continue;
    const n = asNumber(attrs[i]);
    if (n !== undefined) components[attrName] = n;
  }
  return components;
}

/** Read one `IfcBoundaryCondition` entity by expressId. */
export function extractBoundaryCondition(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): BoundaryConditionInfo | undefined {
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;

  const type = normalizeIfcTypeName(entity.type);
  const attrs = entity.attributes || [];
  const components: Record<string, number | boolean> = {};
  const names = getAttributeNames(type);
  for (let i = 0; i < names.length; i++) {
    const attrName = names[i];
    if (attrName === NAME_ATTR) continue;
    // The stiffness selects admit either a measure or IfcBoolean; read the
    // boolean branch first, since a bare `.T.` would not survive the numeric
    // test and a number is never a valid boolean token.
    const b = asBoolean(attrs[i]);
    if (b !== undefined) {
      components[attrName] = b;
      continue;
    }
    const n = asNumber(attrs[i]);
    if (n !== undefined) components[attrName] = n;
  }

  return { expressId, type, name: asString(attrs[0]), components };
}
