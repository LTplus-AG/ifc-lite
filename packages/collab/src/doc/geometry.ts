/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry-reference operations on the Y.Doc.
 *
 * The Y.Doc only ever holds *references* to geometry (parametric params or
 * mesh blob hashes), never raw mesh bytes. This keeps Y.Doc memory small
 * and bounded — see spec §11 and §15.
 */

import * as Y from 'yjs';
import { GEOMETRY_KEY, geometryMap } from './schema.js';

export type GeometryType = 'parametric' | 'mesh' | 'csg-tree';
export type GeometrySource =
  | 'extruded-area-solid'
  | 'swept-disk-solid'
  | 'revolved-area-solid'
  | 'mesh-blob'
  | 'point-cloud'
  | 'csg-op'
  | string;

export type BBox = [number, number, number, number, number, number];

export interface CreateGeometryOptions {
  type: GeometryType;
  source: GeometrySource;
  blobHash?: string;
  params?: Record<string, unknown>;
  bbox?: BBox;
}

export function getGeometry(doc: Y.Doc, geomId: string): Y.Map<unknown> | undefined {
  return geometryMap(doc).get(geomId) as Y.Map<unknown> | undefined;
}

/**
 * Iterate every geometry node in the doc as `[geomId, node]`. Useful for a
 * recipient hydrating all blob-backed meshes directly from the geometry store
 * — entities may reference the same node, and a single entity can own several
 * meshes (multi-material / multiple representation items), so walking the
 * store is more complete than walking per-entity refs.
 */
export function* iterGeometries(doc: Y.Doc): IterableIterator<[string, Y.Map<unknown>]> {
  for (const [geomId, node] of geometryMap(doc).entries()) {
    yield [geomId, node as Y.Map<unknown>];
  }
}

export function createGeometry(
  doc: Y.Doc,
  geomId: string,
  opts: CreateGeometryOptions,
): Y.Map<unknown> {
  const geom = geometryMap(doc);
  const existing = geom.get(geomId);
  if (existing) return existing;

  const node = new Y.Map<unknown>();
  node.set(GEOMETRY_KEY.TYPE, opts.type);
  node.set(GEOMETRY_KEY.SOURCE, opts.source);
  // `!== undefined`, not a truthiness check: an explicit `blobHash: ''`
  // is a value the caller supplied and must survive, the same contract
  // `upsertGeometry` already honours below. A truthy guard here silently
  // drops it before the doc even exists to round-trip from (#1031-adjacent —
  // see round-trip.test.ts).
  if (opts.blobHash !== undefined) node.set(GEOMETRY_KEY.BLOB_HASH, opts.blobHash);

  const params = new Y.Map<unknown>();
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      params.set(k, v);
    }
  }
  node.set(GEOMETRY_KEY.PARAMS, params);

  if (opts.bbox) node.set(GEOMETRY_KEY.BBOX, opts.bbox);

  // The version vector is a Y.Map<peerId, counter> so concurrent replaces
  // become detectable conflicts (§9.4).
  node.set(GEOMETRY_KEY.VERSION_VECTOR, new Y.Map<number>());

  geom.set(geomId, node);
  return node;
}

/**
 * Write a carrier's fields onto a geometry record, creating it if absent.
 *
 * `createGeometry` returns an existing record untouched, which is what seeding
 * a fresh doc wants: a file listing the same `geomId` twice must not have the
 * second mention rewrite the first. An overlay is the opposite case — it exists
 * precisely to carry edits to records the parent already has — so routing it
 * through `createGeometry` drops every in-place geometry change silently, with
 * the merge still reporting success.
 *
 * Carriers are PARTIAL: `geometryRecordLookup` in `snapshot/structured-attrs.ts`
 * omits `blobHash` and `bbox` when absent and `params` entirely when empty.
 * That is why the optional fields are guarded here — an absent field is "no
 * opinion", not "clear it".
 *
 * `params` therefore MERGE rather than replace, for a reason that was measured:
 * merging emits one Yjs change per key at `[geomId, 'params']`, which
 * `conflicts/detector.ts` classifies as a `geometry-param` conflict, while
 * `node.set(PARAMS, new Y.Map())` emits a single change at `[geomId]` that
 * `classify` returns null for — so replacing would make a concurrent param edit
 * stop being a detectable conflict.
 *
 * Two costs, both real. A param the branch DELETED cannot be represented, the
 * same limit the overlay has for structured removals generally. And because
 * `type`/`source` are required and so always written while the optional fields
 * are not, a stale carrier can leave a record mixing one representation's
 * type with another's `blobHash`.
 *
 * The version vector is deliberately left alone: it records who replaced this
 * geometry, and applying someone's overlay is not this peer replacing it.
 * `bumpGeometryVersion` is the explicit way to say that.
 */
export function upsertGeometry(
  doc: Y.Doc,
  geomId: string,
  opts: CreateGeometryOptions,
): Y.Map<unknown> {
  const node = getGeometry(doc, geomId);
  if (!node) return createGeometry(doc, geomId, opts);

  node.set(GEOMETRY_KEY.TYPE, opts.type);
  node.set(GEOMETRY_KEY.SOURCE, opts.source);
  if (opts.blobHash !== undefined) node.set(GEOMETRY_KEY.BLOB_HASH, opts.blobHash);
  if (opts.bbox !== undefined) node.set(GEOMETRY_KEY.BBOX, opts.bbox);
  if (opts.params) {
    let params = node.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
    if (!params) {
      params = new Y.Map<unknown>();
      node.set(GEOMETRY_KEY.PARAMS, params);
    }
    for (const [k, v] of Object.entries(opts.params)) params.set(k, v);
  }
  return node;
}

export function setGeometryParam(
  doc: Y.Doc,
  geomId: string,
  paramName: string,
  value: unknown,
): void {
  const node = getGeometry(doc, geomId);
  if (!node) throw new Error(`@ifc-lite/collab: geometry "${geomId}" not found`);
  const params = node.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
  if (!params) throw new Error(`@ifc-lite/collab: geometry "${geomId}" missing params map`);
  params.set(paramName, value);
}

export function setGeometryBlobHash(doc: Y.Doc, geomId: string, blobHash: string): void {
  const node = getGeometry(doc, geomId);
  if (!node) throw new Error(`@ifc-lite/collab: geometry "${geomId}" not found`);
  node.set(GEOMETRY_KEY.BLOB_HASH, blobHash);
}

/**
 * Bump the version vector for a peer when this peer replaces geometry. The
 * conflict detector (`conflicts/detector.ts`) uses these vectors to
 * identify concurrent replacements.
 */
export function bumpGeometryVersion(doc: Y.Doc, geomId: string, peerId: string | number): void {
  const node = getGeometry(doc, geomId);
  if (!node) throw new Error(`@ifc-lite/collab: geometry "${geomId}" not found`);
  const vv = node.get(GEOMETRY_KEY.VERSION_VECTOR) as Y.Map<number> | undefined;
  if (!vv) throw new Error(`@ifc-lite/collab: geometry "${geomId}" missing version vector`);
  const key = String(peerId);
  vv.set(key, (vv.get(key) ?? 0) + 1);
}

export function deleteGeometry(doc: Y.Doc, geomId: string): boolean {
  const geom = geometryMap(doc);
  if (!geom.has(geomId)) return false;
  geom.delete(geomId);
  return true;
}

/** Plain JSON snapshot of a geometry node (used by the IFCX writer). */
export function geometryToJSON(node: Y.Map<unknown>): {
  type: GeometryType;
  source: GeometrySource;
  params: Record<string, unknown>;
  blobHash?: string;
  bbox?: BBox;
  versionVector: Record<string, number>;
} {
  const params = node.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
  const vv = node.get(GEOMETRY_KEY.VERSION_VECTOR) as Y.Map<number> | undefined;
  const paramsJson: Record<string, unknown> = {};
  if (params) for (const [k, v] of params.entries()) paramsJson[k] = v;
  const vvJson: Record<string, number> = {};
  if (vv) for (const [k, v] of vv.entries()) vvJson[k] = v;
  return {
    type: node.get(GEOMETRY_KEY.TYPE) as GeometryType,
    source: node.get(GEOMETRY_KEY.SOURCE) as GeometrySource,
    params: paramsJson,
    blobHash: node.get(GEOMETRY_KEY.BLOB_HASH) as string | undefined,
    bbox: node.get(GEOMETRY_KEY.BBOX) as BBox | undefined,
    versionVector: vvJson,
  };
}
