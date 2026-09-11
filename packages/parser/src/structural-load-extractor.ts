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
   * the parametric locations they apply at, as {@link StructuralLoadConfigurationInfo}.
   */
  configuration?: StructuralLoadConfigurationInfo;
}

/**
 * Why one `Values` slot carries no nested load.
 *
 * The first three are **our** bounds firing — the file may hold more than we
 * agreed to read, and {@link StructuralLoadConfigurationInfo.truncated} is set.
 * The last three are the file's own data: there is nothing further to read, so
 * they are not truncation.
 */
export type StructuralLoadDropReason =
  /** Below the nesting cap: the chain is longer than this reader follows. */
  | 'depth'
  /** The slot re-enters a configuration already open on this path. */
  | 'cycle'
  /** The node budget for this top-level load was spent before this slot. */
  | 'budget'
  /** The slot is not an entity reference at all (`$`, an inline value, …). */
  | 'invalid-reference'
  /** The referenced expressId is in no index — a dangling reference. */
  | 'unresolved'
  /** The referenced record is indexed but did not parse. */
  | 'unreadable';

/** One `Values` slot of an `IfcStructuralLoadConfiguration`, with its location. */
export interface StructuralLoadConfigurationEntry {
  /** The nested load, absent when the slot could not be read. */
  value?: StructuralLoadInfo;
  /** Why {@link value} is absent; absent whenever `value` is present. */
  dropped?: StructuralLoadDropReason;
  /**
   * The `Locations` row at this same slot, when the file carries one. Absent
   * when the file omits the optional `Locations`, or lists fewer rows than
   * `Values` has slots.
   */
  location?: number[];
}

/** The `Values`/`Locations` pair of an `IfcStructuralLoadConfiguration`. */
export interface StructuralLoadConfigurationInfo {
  /**
   * One entry per `Values` slot, in file order. The pairing the schema
   * requires — the i-th location positions the i-th value — is carried inside
   * the entry rather than across two arrays, so a slot this reader could not
   * resolve keeps its place with `value` absent and `dropped` naming why. A
   * dropped slot that instead shifted its successors left would report a later
   * load as applied at an earlier station, which reads as real data.
   */
  entries: StructuralLoadConfigurationEntry[];
  /**
   * `Locations` as the file writes it, absent when the file omits it or writes
   * it unusably. Kept beside {@link entries} for the malformed case where it is
   * longer than `Values`: those extra rows belong to no slot and would
   * otherwise be lost. Consumers pairing a load with its station read
   * `entries[i].location`, never this list.
   */
  locations?: number[][];
  /**
   * True when a bound of this reader — the depth cap, the node budget, or the
   * cycle guard — dropped a slot in this configuration or anywhere beneath it.
   * It separates "the file holds no more" from "we stopped reading", which a
   * truncated tree otherwise reports identically to a genuinely small one.
   */
  truncated: boolean;
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
 *   suppress the repeat as if it were a cycle and report one load where the
 *   file applies two.
 * - a **depth cap** bounds one chain's length, which the cycle set alone does
 *   not for a long acyclic chain.
 * - a **node budget** bounds total work. The first two still admit `k`
 *   children each recursing `k` deep, which is O(k^depth) — an abort turned
 *   into a hang, and a hang reports nothing.
 *
 * All three, and an unreadable reference besides, keep the `Values` slot they
 * gave up on: it becomes an entry with no `value` and a `dropped` reason, so
 * the station a `Locations` row names still belongs to the load the file put
 * there. Only the three bounds set `truncated`, since only they mean the file
 * holds more than this reader agreed to walk.
 */
export function extractStructuralLoad(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): StructuralLoadInfo | undefined {
  return readLoad(extractor, store, expressId, new Set(), { remaining: MAX_LOAD_NODES }, 0).value;
}

/**
 * One resolved slot: the load, or the reason there is none, plus whether a
 * bound fired anywhere in the subtree rooted here. The reason is returned
 * rather than swallowed because the caller has to keep the slot either way.
 */
interface LoadReadResult {
  value?: StructuralLoadInfo;
  dropped?: StructuralLoadDropReason;
  truncated: boolean;
}

function readLoad(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
  path: Set<number>,
  budget: { remaining: number },
  depth: number,
): LoadReadResult {
  if (depth > MAX_LOAD_DEPTH) return { dropped: 'depth', truncated: true };
  if (path.has(expressId)) return { dropped: 'cycle', truncated: true };
  if (budget.remaining <= 0) return { dropped: 'budget', truncated: true };
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return { dropped: 'unresolved', truncated: false };
  const entity = extractor.extractEntity(ref);
  if (!entity) return { dropped: 'unreadable', truncated: false };

  budget.remaining--;
  const type = normalizeIfcTypeName(entity.type);
  const attrs = entity.attributes || [];

  if (type.toUpperCase() === 'IFCSTRUCTURALLOADCONFIGURATION') {
    const locations = readLocations(attrs[LOAD_CONFIGURATION_ATTR.Locations]);
    const entries: StructuralLoadConfigurationEntry[] = [];
    let truncated = false;
    const values = attrs[LOAD_CONFIGURATION_ATTR.Values];
    if (Array.isArray(values)) {
      // On this node's path only — removed again below so a sibling that
      // names the same load still reads it.
      path.add(expressId);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const location = locations?.[i];
        const slot: LoadReadResult =
          typeof v === 'number' && Number.isInteger(v) && v > 0
            ? readLoad(extractor, store, v, path, budget, depth + 1)
            : { dropped: 'invalid-reference', truncated: false };
        if (slot.truncated) truncated = true;
        entries.push({ value: slot.value, dropped: slot.dropped, location });
      }
      path.delete(expressId);
    }
    return {
      value: {
        expressId,
        type,
        name: asString(attrs[LOAD_CONFIGURATION_ATTR.Name]),
        components: {},
        configuration: { entries, locations, truncated },
      },
      truncated,
    };
  }

  return {
    value: {
      expressId,
      type,
      name: asString(attrs[0]),
      components: readNumericComponents(type, attrs),
    },
    truncated: false,
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
