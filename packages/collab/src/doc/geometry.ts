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
  if (opts.blobHash) node.set(GEOMETRY_KEY.BLOB_HASH, opts.blobHash);

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
