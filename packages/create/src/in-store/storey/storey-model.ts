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
import { createSchemaEntityNameSnapshot, getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
import { effectiveReferencers } from '@ifc-lite/export';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { refId } from '../host-geometry-frame.js';
import { safeLengthUnitScale } from '../length-unit-scale.js';
import { effectiveStoreyElevation } from '../room-storey-elevation.js';
import type { StoreyRefusal } from './storey-validation.js';

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
  /** `incoming.get(id) ?? []`, answered from the reference index while the
   * whole relationship graph has not been read (see `lazyRelationships`). */
  incomingOf?(id: number): readonly StoreyRelationship[];
}

/** Options for {@link readStoreyInventory}. */
export interface StoreyInventoryOptions {
  /**
   * Read the whole relationship graph only if `relationships`, `outgoing` or
   * `incoming` is asked for, from the overlay as it stands then (#8452).
   * `incomingOf` and the storey list answer per element through the reference
   * index. For callers that only ask about a few elements before writing,
   * such as a copy batch reading its sources' attachments.
   */
  readonly lazyRelationships?: boolean;
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

/** One live relationship with only its live ends: a deleted product is nobody's content. */
function spatialRelationship(reader: AnchorEntityReader, id: number, type: string, deleted: ReadonlySet<number>): StoreyRelationship | null {
  const entity = reader.entity(id);
  if (!entity) return null;
  const contained = type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
  const parentIndex = contained ? 5 : 4;
  const listIndex = contained ? 4 : 5;
  const parent = refId(entity.attributes[parentIndex]);
  const raw = entity.attributes[listIndex];
  const children = (Array.isArray(raw) ? raw : [raw]).map(refId)
    .filter((child): child is number => child !== null && !deleted.has(child));
  if (parent === null || deleted.has(parent) || children.length === 0) return null;
  return { id, type, parent, children, parentIndex, listIndex };
}

/** Live relationships only, and only their live ends. */
function relationshipsOf(reader: AnchorEntityReader, deleted: ReadonlySet<number>, types: readonly string[] = SPATIAL_RELATIONSHIPS): StoreyRelationship[] {
  const result: StoreyRelationship[] = [];
  for (const type of types) {
    for (const id of reader.ids(type)) {
      const rel = spatialRelationship(reader, id, type, deleted);
      if (rel) result.push(rel);
    }
  }
  return result;
}

function relationshipMaps(relationships: readonly StoreyRelationship[]) {
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
  return { relationships, outgoing, incoming };
}

/** The non-aggregate spatial relationships naming `id` as a child, found
 * through its effective referencers. A storey is named by every containment
 * relationship it parents, so its own parents come from the aggregates. */
function incomingThroughReferencers(
  reader: AnchorEntityReader, referencers: (id: number) => readonly number[], id: number, deleted: ReadonlySet<number>,
): StoreyRelationship[] {
  const found: StoreyRelationship[] = [];
  for (const relId of referencers(id)) {
    const type = reader.entity(relId)?.type.toUpperCase();
    if (!type || type === 'IFCRELAGGREGATES' || !(SPATIAL_RELATIONSHIPS as readonly string[]).includes(type)) continue;
    const rel = spatialRelationship(reader, relId, type, deleted);
    if (rel?.children.includes(id)) found.push(rel);
  }
  // The order a whole-graph read lists them in: relationship class, then id.
  const rank = (type: string) => (SPATIAL_RELATIONSHIPS as readonly string[]).indexOf(type);
  return found.sort((a, b) => rank(a.type) - rank(b.type) || a.id - b.id);
}

/** Read the live storeys and spatial relationships of one model. */
export function readStoreyInventory(store: IfcDataStore, view: MutablePropertyView, options: StoreyInventoryOptions = {}): StoreyInventory {
  const names = createSchemaEntityNameSnapshot(getSchemaRegistryForVersion(store.schemaVersion === 'IFC2X3' ? 'IFC2X3' : store.schemaVersion === 'IFC4X3' || store.schemaVersion === 'IFC5' ? 'IFC4X3' : 'IFC4'));
  const reader = new CachedReader(store, view, names);
  const scale = store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, 'readStoreyInventory') ?? 1
    : store.lengthUnitScale ?? 1;
  const deleted = view.getTombstones();
  let graph = options.lazyRelationships ? undefined : relationshipMaps(relationshipsOf(reader, deleted));
  const full = () => graph ??= relationshipMaps(relationshipsOf(reader, deleted));
  // Aggregates are few (the spatial tree and assemblies); read them whole.
  const aggregates = graph ? undefined : relationshipMaps(relationshipsOf(reader, deleted, ['IFCRELAGGREGATES']));
  let referencers: ((id: number) => readonly number[]) | undefined;
  const incomingById = new Map<number, readonly StoreyRelationship[]>();
  const incomingOf = (id: number): readonly StoreyRelationship[] => {
    if (graph) return graph.incoming.get(id) ?? [];
    let rels = incomingById.get(id);
    if (!rels) {
      incomingById.set(id, rels = [...aggregates!.incoming.get(id) ?? [],
        ...incomingThroughReferencers(reader, referencers ??= effectiveReferencers(store, view), id, deleted)]);
    }
    return rels;
  };
  const storeys: StoreyRecord[] = [];
  for (const expressId of reader.ids('IFCBUILDINGSTOREY')) {
    const entity = reader.entity(expressId);
    if (!entity) continue;
    const aggregate = (graph ?? aggregates!).incoming.get(expressId)?.find((rel) => rel.type === 'IFCRELAGGREGATES');
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
  return {
    store, view, reader, scale, schema: String(store.schemaVersion ?? 'IFC4').toUpperCase(), storeys,
    get relationships() { return full().relationships; },
    get outgoing() { return full().outgoing; },
    get incoming() { return full().incoming; },
    incomingOf,
  };
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
  const record = storeyRecord(inventory, storeyId);
  // A storey no building aggregates belongs to no sequence: two such storeys
  // may stand in different buildings, so neither is the other's neighbour.
  if (record.parentId === null) return [record];
  return inventory.storeys.filter((storey) => storey.parentId === record.parentId);
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
  const contents = boundedStoreyContents(inventory, storeyId, limit);
  if (!contents) throw new Error(storeyTooLarge(storeyRecord(inventory, storeyId), limit).message);
  return contents;
}

/** `storeyContents`, or null past `limit` (the walk stops there): planners turn that into a refusal. */
export function boundedStoreyContents(inventory: StoreyInventory, storeyId: number, limit = STOREY_CONTENT_LIMIT): Set<number> | null {
  return walkStoreyContents(inventory, storeyId, limit)?.contents ?? null;
}

/**
 * The storey's contents, and the products another storey contains that its
 * elements reach through voids, fillings or nesting (a window contained in
 * Level 3 filling an opening in a Level 2 wall), each with its own storey.
 * Those are not this storey's contents; an edit that would separate them
 * from their host is refused by the planners.
 */
export function walkStoreyContents(
  inventory: StoreyInventory, storeyId: number, limit = STOREY_CONTENT_LIMIT,
): { contents: Set<number>; foreign: Map<number, number> } | null {
  const storeyIds = new Set(inventory.storeys.map((storey) => storey.expressId));
  // The storey a product's spatial container belongs to: the container itself, or the storey a
  // space (or other spatial element) is aggregated under, however deep.
  const storeyOf = (spatial: number): number | undefined => {
    const seen = new Set<number>();
    for (let id: number | undefined = spatial; id !== undefined && !seen.has(id);) {
      if (storeyIds.has(id)) return id;
      seen.add(id);
      id = (inventory.incoming.get(id) ?? []).find((rel) => rel.type === 'IFCRELAGGREGATES')?.parent;
    }
    return undefined;
  };
  const containedIn = (product: number) => {
    const rel = (inventory.incoming.get(product) ?? []).find((candidate) => candidate.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
    return rel ? storeyOf(rel.parent) : undefined;
  };
  const contents = new Set<number>();
  const foreign = new Map<number, number>();
  const queue = [storeyId];
  for (let index = 0; index < queue.length; index++) {
    for (const rel of inventory.outgoing.get(queue[index]) ?? []) {
      for (const child of rel.children) {
        if (child === storeyId || contents.has(child) || foreign.has(child) || storeyIds.has(child)) continue;
        const own = rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' ? undefined : containedIn(child);
        if (own !== undefined && own !== storeyId) { foreign.set(child, own); continue; }
        if (contents.size >= limit) return null;
        contents.add(child);
        queue.push(child);
      }
    }
  }
  return { contents, foreign };
}

/** The refusal for products of other storeys that `storey`'s elements host, when they would come apart. */
export function crossStoreyRefusal(inventory: StoreyInventory, storey: StoreyRecord, foreign: ReadonlyMap<number, number>): StoreyRefusal | null {
  if (foreign.size === 0) return null;
  const names = [...new Set([...foreign.values()].map((id) => inventory.storeys.find((s) => s.expressId === id)?.Name ?? `#${id}`))];
  return {
    code: 'dependent', elementIds: [...foreign.keys()],
    message: `${foreign.size} element(s) contained in ${names.join(', ')} fill or hang from elements of ${storey.Name}; move them with it or re-host them first`,
    params: { storey: storey.Name },
  };
}

/** The refusal for a storey whose contents pass the planning limit. */
export function storeyTooLarge(storey: Pick<StoreyRecord, 'expressId' | 'Name'>, limit = STOREY_CONTENT_LIMIT): StoreyRefusal {
  return {
    code: 'tooLarge', elementIds: [storey.expressId],
    message: `${storey.Name} holds more than ${limit.toLocaleString('en')} products, more than one storey edit may write`,
    params: { storey: storey.Name, limit },
  };
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
