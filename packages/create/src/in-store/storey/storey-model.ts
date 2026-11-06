/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The effective storey inventory behind every storey edit (#9013): the live
 * storeys of a parsed model (overlay creations and edits included, tombstones
 * excluded), their spatial parents and the products each one contains.
 *
 * One inventory is one synchronous snapshot. Plans built from it are only
 * valid for the mutation revision it was read at; the apply functions
 * re-read inside their atomic draft and refuse a stale plan.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { refId } from '../host-geometry-frame.js';
import { safeLengthUnitScale } from '../length-unit-scale.js';
import { effectiveStoreyElevation } from '../room-storey-elevation.js';

/** A mutation plan refuses a storey holding more products than this; read-only listings count past it. */
export const STOREY_CONTENT_LIMIT = 50_000;

export interface StoreyRelationship {
  readonly id: number;
  /** Upper-case STEP type. */
  readonly type: string;
  readonly parent: number;
  readonly children: readonly number[];
  readonly parentIndex: number;
  readonly listIndex: number;
}

export interface StoreyRecord {
  readonly expressId: number;
  readonly GlobalId: string;
  readonly Name: string;
  /** Live elevation in metres (the renderer frame), as the workspace reads it. */
  readonly elevation: number;
  /** `IfcBuildingStorey.Elevation` in file units, or null when the file leaves it unset. */
  readonly elevationAttribute: number | null;
  readonly placementId: number | null;
  /** The spatial element aggregating this storey (usually the IfcBuilding), or null. */
  readonly parentId: number | null;
  /** The IfcRelAggregates that lists this storey under its parent, or null. */
  readonly aggregateRelId: number | null;
}

export interface StoreyInventory {
  readonly store: IfcDataStore;
  readonly view: MutablePropertyView;
  readonly reader: AnchorEntityReader;
  /** Metres per file length unit. */
  readonly scale: number;
  readonly schema: string;
  /** Lowest first; equal elevations keep express-id order. */
  readonly storeys: readonly StoreyRecord[];
  readonly relationships: readonly StoreyRelationship[];
  readonly outgoing: ReadonlyMap<number, readonly StoreyRelationship[]>;
  readonly incoming: ReadonlyMap<number, readonly StoreyRelationship[]>;
}

const SPATIAL_RELATIONSHIPS = [
  'IFCRELAGGREGATES', 'IFCRELNESTS', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELCONTAINEDINSPATIALSTRUCTURE',
] as const;

/** A reader that reads each record once per planning request. */
class CachedReader extends AnchorEntityReader {
  private readonly records = new Map<number, ReturnType<AnchorEntityReader['entity']>>();
  override entity(id: number) {
    if (!this.records.has(id)) this.records.set(id, super.entity(id));
    return this.records.get(id) ?? null;
  }
}

function realValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && 'real' in value) {
    const real = (value as { real: unknown }).real;
    return typeof real === 'number' && Number.isFinite(real) ? real : null;
  }
  if (Array.isArray(value) && typeof value[1] === 'number' && Number.isFinite(value[1])) return value[1];
  return null;
}

function relationshipsOf(reader: AnchorEntityReader): StoreyRelationship[] {
  const result: StoreyRelationship[] = [];
  for (const type of SPATIAL_RELATIONSHIPS) {
    for (const id of reader.ids(type)) {
      const entity = reader.entity(id);
      if (!entity) continue;
      const contained = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
      const parentIndex = contained ? 5 : 4;
      const listIndex = contained ? 4 : 5;
      const parent = refId(entity.attributes[parentIndex]);
      const raw = entity.attributes[listIndex];
      const children = (Array.isArray(raw) ? raw : [raw]).map(refId).filter((child): child is number => child !== null);
      if (parent === null || children.length === 0) continue;
      result.push({ id, type, parent, children, parentIndex, listIndex });
    }
  }
  return result;
}

/** Read the live storeys and spatial relationships of one model. */
export function readStoreyInventory(store: IfcDataStore, view: MutablePropertyView): StoreyInventory {
  const reader = new CachedReader(store, view);
  const scale = store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, 'readStoreyInventory') ?? 1
    : store.lengthUnitScale ?? 1;
  const relationships = relationshipsOf(reader);
  const outgoing = new Map<number, StoreyRelationship[]>();
  const incoming = new Map<number, StoreyRelationship[]>();
  const append = (map: Map<number, StoreyRelationship[]>, key: number, rel: StoreyRelationship) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(rel); else map.set(key, [rel]);
  };
  for (const rel of relationships) {
    append(outgoing, rel.parent, rel);
    for (const child of rel.children) append(incoming, child, rel);
  }
  const storeys: StoreyRecord[] = [];
  for (const expressId of reader.ids('IFCBUILDINGSTOREY')) {
    const entity = reader.entity(expressId);
    if (!entity) continue;
    const aggregate = (incoming.get(expressId) ?? []).find((rel) => rel.type === 'IFCRELAGGREGATES');
    storeys.push({
      expressId,
      GlobalId: typeof entity.attributes[0] === 'string' ? entity.attributes[0] : '',
      Name: typeof entity.attributes[2] === 'string' && entity.attributes[2] ? entity.attributes[2] : `#${expressId}`,
      elevation: effectiveStoreyElevation(store, view, expressId),
      elevationAttribute: realValue(entity.attributes[9]),
      placementId: reader.storeyPlacementId(expressId),
      parentId: aggregate?.parent ?? null,
      aggregateRelId: aggregate?.id ?? null,
    });
  }
  storeys.sort((a, b) => a.elevation - b.elevation || a.expressId - b.expressId);
  return { store, view, reader, scale, schema: String(store.schemaVersion ?? 'IFC4').toUpperCase(), storeys, relationships, outgoing, incoming };
}

export function storeyRecord(inventory: StoreyInventory, storeyId: number): StoreyRecord {
  const record = inventory.storeys.find((storey) => storey.expressId === storeyId);
  if (!record) throw new Error(`#${storeyId} is not a live IfcBuildingStorey in this model`);
  return record;
}

/**
 * The storeys sharing `storeyId`'s spatial parent (its building), lowest
 * first. Levels are a per-building sequence: in a model with two buildings,
 * one building's ground floor is not the other's storey above or below.
 */
export function siblingStoreys(inventory: StoreyInventory, storeyId: number): StoreyRecord[] {
  const parentId = storeyRecord(inventory, storeyId).parentId;
  return inventory.storeys.filter((storey) => storey.parentId === parentId);
}

/** The storey directly above / below in elevation order within its building, or null. */
export function storeyNeighbour(inventory: StoreyInventory, storeyId: number, direction: 1 | -1): StoreyRecord | null {
  const siblings = siblingStoreys(inventory, storeyId);
  const index = siblings.findIndex((storey) => storey.expressId === storeyId);
  return index < 0 ? null : siblings[index + direction] ?? null;
}

/** Floor-to-floor height in metres to the storey above, or null for the top storey. */
export function storeySpacingAbove(inventory: StoreyInventory, storeyId: number): number | null {
  const above = storeyNeighbour(inventory, storeyId, 1);
  return above ? above.elevation - storeyRecord(inventory, storeyId).elevation : null;
}

/**
 * Everything a storey holds: what it contains, the spatial elements it
 * aggregates (spaces, sub-storeys excluded) and, transitively, their
 * aggregated and nested parts, their openings and fillings, and what those
 * spatial elements contain in turn. Iterative with a visited set.
 *
 * Throws beyond `limit` products: a plan that would write that many is
 * refused. Read-only callers pass `Infinity`.
 */
export function storeyContents(inventory: StoreyInventory, storeyId: number, limit = STOREY_CONTENT_LIMIT): Set<number> {
  const storeyIds = new Set(inventory.storeys.map((storey) => storey.expressId));
  const contents = new Set<number>();
  const queue = [storeyId];
  for (let index = 0; index < queue.length; index++) {
    for (const rel of inventory.outgoing.get(queue[index]) ?? []) {
      for (const child of rel.children) {
        if (child === storeyId || contents.has(child) || storeyIds.has(child)) continue;
        if (contents.size >= limit) {
          throw new Error(`Storey #${storeyId} holds more than ${limit.toLocaleString('en')} products`);
        }
        contents.add(child);
        queue.push(child);
      }
    }
  }
  return contents;
}

/** Elements a person counts: the contents minus openings and aggregated parts. */
export function countedElements(inventory: StoreyInventory, contents: ReadonlySet<number>): number {
  let count = 0;
  for (const id of contents) {
    const type = inventory.reader.entity(id)?.type.toUpperCase();
    if (type === 'IFCOPENINGELEMENT') continue;
    const part = (inventory.incoming.get(id) ?? []).some((rel) => rel.type === 'IFCRELAGGREGATES' && contents.has(rel.parent));
    if (!part) count++;
  }
  return count;
}

export const ref = (id: number): string => `#${id}`;

export interface StoreySummary {
  readonly expressId: number;
  readonly GlobalId: string;
  readonly Name: string;
  /** Metres. */
  readonly elevation: number;
  /** Metres to the storey above, or null for the top storey. */
  readonly height: number | null;
  readonly elementCount: number;
}

/** One row per storey, highest first: what a storey manager lists. Never refused for size. */
export function summarizeStoreys(inventory: StoreyInventory): StoreySummary[] {
  return inventory.storeys.map((storey) => {
    const above = storeyNeighbour(inventory, storey.expressId, 1);
    return {
      expressId: storey.expressId,
      GlobalId: storey.GlobalId,
      Name: storey.Name,
      elevation: storey.elevation,
      height: above ? above.elevation - storey.elevation : null,
      elementCount: countedElements(inventory, storeyContents(inventory, storey.expressId, Infinity)),
    };
  }).reverse();
}
