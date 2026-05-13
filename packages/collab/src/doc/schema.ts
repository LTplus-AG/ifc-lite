/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Y.Doc schema for the collaborative BIM runtime.
 *
 * Mirrors the spec §5 data model, adapted to the actual IFCX wire shape
 * (path + flat namespaced attributes + role→path children).
 */

import * as Y from 'yjs';

/** Top-level shared-type names. */
export const TOP = {
  ENTITIES: 'entities',
  RELATIONSHIPS: 'relationships',
  GEOMETRY: 'geometry',
  META: 'meta',
} as const;

/** Origin tag used for transactions originated by the local CollabSession. */
export const LOCAL_ORIGIN = Symbol.for('@ifc-lite/collab/local-origin');

/** Origin tag for transactions originated by snapshot seeding. */
export const SEED_ORIGIN = Symbol.for('@ifc-lite/collab/seed-origin');

/** Origin tag for transactions originated by undo/redo. */
export const UNDO_ORIGIN = Symbol.for('@ifc-lite/collab/undo-origin');

/**
 * Per-entity Y.Map keys.
 *
 * Each entity is a Y.Map with these well-known sub-maps. Sub-maps are
 * themselves Y.Maps so concurrent edits to different sub-maps never
 * conflict.
 */
export const ENTITY_KEY = {
  /** IFCX `attributes` — flat record keyed by namespaced names. */
  ATTRIBUTES: 'attributes',
  /** IFCX `children` — role → path. */
  CHILDREN: 'children',
  /** IFCX `inherits` — role → path. */
  INHERITS: 'inherits',
  /** Property sets, grouped: psetName → propName → PropertyValue. */
  PSETS: 'psets',
  /** Quantity sets: qsetName → quantityName → number. */
  QUANTITIES: 'quantities',
  /** Classification refs (Y.Array). */
  CLASSIFICATIONS: 'classifications',
  /** Material assignments (Y.Array). */
  MATERIALS: 'materials',
  /** Reference into the `geometry` top-level map. */
  GEOMETRY_REF: 'geometryRef',
  /** Provenance metadata: createdBy, createdAt, lastEditedBy, etc. */
  META: 'meta',
} as const;

/** Per-relationship Y.Map keys. */
export const RELATIONSHIP_KEY = {
  IFC_CLASS: 'ifcClass',
  SOURCE: 'source',
  TARGETS: 'targets',
  ATTRIBUTES: 'attributes',
} as const;

/** Per-geometry Y.Map keys. */
export const GEOMETRY_KEY = {
  TYPE: 'type',
  SOURCE: 'source',
  PARAMS: 'params',
  BLOB_HASH: 'blobHash',
  BBOX: 'bbox',
  VERSION_VECTOR: 'versionVector',
} as const;

/**
 * A typed property value as stored in a Pset Y.Map.
 *
 * We store these as plain JSON values (not Y.Maps) because the property
 * value is replaced atomically; partial updates to the typed shape are not
 * meaningful at the IFC level.
 */
export interface PropertyValue {
  type:
    | 'IfcLabel'
    | 'IfcText'
    | 'IfcReal'
    | 'IfcInteger'
    | 'IfcBoolean'
    | 'IfcLogical'
    | 'IfcIdentifier'
    | string;
  value: string | number | boolean | null;
  unit?: string;
  /** Provenance: 'manual' | 'bsdd:<uri>' | 'derived' | 'ifcx:<layer>'. */
  source?: string;
}

/** Classification reference. */
export interface ClassificationRef {
  system: string;
  code: string;
  uri?: string;
  description?: string;
}

/** Material assignment record. */
export interface MaterialAssignment {
  materialId: string;
  layerName?: string;
  thickness?: number;
  fraction?: number;
}

/** Geometry reference stored on each entity. */
export interface GeometryRefRecord {
  /** Pointer into the `geometry` top-level map (== that entry's geomId). */
  geomId: string;
}

/** Entity metadata. */
export interface EntityMeta {
  ifcClass?: string;
  schemaVersion?: 'ifc4' | 'ifc4x3' | 'ifc5';
  createdBy?: string;
  createdAt?: string;
  lastEditedBy?: string;
  lastEditedAt?: string;
  /** For type promotion: previous path before delete+create. */
  previousPath?: string;
  /** Free-form per-entity metadata. */
  [key: string]: unknown;
}

/**
 * Create a fresh, empty Y.Doc with the spec's top-level shared types.
 *
 * Idempotent: calling `getMap` twice returns the same shared type, so this
 * is safe to call on an already-populated doc as well.
 */
export function createCollabDoc(opts: { gc?: boolean } = {}): Y.Doc {
  const doc = new Y.Doc({ gc: opts.gc ?? true });
  // Force the shared types into existence so observers attached early see
  // them. Y.Map is created lazily by getMap, so this is a no-op if they
  // already exist.
  doc.getMap(TOP.ENTITIES);
  doc.getMap(TOP.RELATIONSHIPS);
  doc.getMap(TOP.GEOMETRY);
  doc.getMap(TOP.META);
  return doc;
}

/** Top-level accessors. Centralized so refactors stay safe. */
export function entitiesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(TOP.ENTITIES) as Y.Map<Y.Map<unknown>>;
}

export function relationshipsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(TOP.RELATIONSHIPS) as Y.Map<Y.Map<unknown>>;
}

export function geometryMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(TOP.GEOMETRY) as Y.Map<Y.Map<unknown>>;
}

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(TOP.META);
}

/**
 * Runtime invariant check used by tests and seeding.
 *
 * Throws if the Y.Doc does not have the expected shape. We check structural
 * presence and type shape, not content, so an empty fresh doc passes.
 */
export function assertSchemaInvariants(doc: Y.Doc): void {
  const ents = doc.share.get(TOP.ENTITIES);
  const rels = doc.share.get(TOP.RELATIONSHIPS);
  const geom = doc.share.get(TOP.GEOMETRY);
  if (!ents || !(ents instanceof Y.Map)) {
    throw new Error(`@ifc-lite/collab: missing top-level Y.Map "${TOP.ENTITIES}"`);
  }
  if (!rels || !(rels instanceof Y.Map)) {
    throw new Error(`@ifc-lite/collab: missing top-level Y.Map "${TOP.RELATIONSHIPS}"`);
  }
  if (!geom || !(geom instanceof Y.Map)) {
    throw new Error(`@ifc-lite/collab: missing top-level Y.Map "${TOP.GEOMETRY}"`);
  }
}
