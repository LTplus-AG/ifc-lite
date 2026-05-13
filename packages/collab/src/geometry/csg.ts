/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSG (constructive solid geometry) operation tree as a Y.Array<CSGOp>.
 *
 * Spec §9.4 / §11 + open problem #4: full CRDT-tree merging of CSG ops is
 * a v1.x topic. v0.1 stores ops as an ordered Y.Array — concurrent
 * additions from two peers interleave preserving each peer's relative
 * order, and a UI can drag-to-reorder via explicit moves. The CSG result
 * is order-dependent; that's exposed honestly in the README.
 *
 * The geometry node referenced here is one of the Y.Doc's
 * `geometry` top-level entries with `type: 'csg-tree'`. The tree's ops
 * live as a Y.Array on `params.ops` so they ride the same CRDT machinery
 * as parametric params.
 */

import * as Y from 'yjs';
import { GEOMETRY_KEY, geometryMap } from '../doc/schema.js';
import { createGeometry } from '../doc/geometry.js';

export type CSGBoolean = 'union' | 'difference' | 'intersection' | 'xor';

export interface CSGOp {
  /** Stable per-op UUID. We push (op) records, not (op, payload) pairs. */
  opId: string;
  /** Boolean operator applied between the previous accumulator and `operandGeomId`. */
  op: CSGBoolean;
  /** geomId of the operand — points into the same Y.Doc geometry map. */
  operandGeomId: string;
  /** Optional transform applied to the operand before the boolean. */
  transform?: number[];
  /** Authoring metadata (which user added this op). */
  author?: string;
  /** Wall-clock authoring time. */
  at?: string;
}

export interface CreateCSGTreeOptions {
  /** Optional initial op list. */
  ops?: CSGOp[];
  /** Initial bounding box estimate. */
  bbox?: [number, number, number, number, number, number];
}

/**
 * Get-or-create a CSG-tree geometry node and return its `ops` Y.Array.
 *
 * Idempotent: if the geometry already exists with `type==='csg-tree'`,
 * returns the existing ops Y.Array.
 */
export function ensureCSGTree(
  doc: Y.Doc,
  geomId: string,
  options: CreateCSGTreeOptions = {},
): Y.Array<CSGOp> {
  let node = geometryMap(doc).get(geomId) as Y.Map<unknown> | undefined;
  if (!node) {
    node = createGeometry(doc, geomId, {
      type: 'csg-tree',
      source: 'csg-op',
      bbox: options.bbox,
    });
  }
  const params = node.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
  if (!params) throw new Error(`@ifc-lite/collab: csg-tree "${geomId}" missing params map`);
  let ops = params.get('ops') as Y.Array<CSGOp> | undefined;
  if (!ops) {
    ops = new Y.Array<CSGOp>();
    params.set('ops', ops);
  }
  if (options.ops && ops.length === 0) ops.push(options.ops);
  return ops;
}

export function getCSGOps(doc: Y.Doc, geomId: string): CSGOp[] {
  const node = geometryMap(doc).get(geomId) as Y.Map<unknown> | undefined;
  const params = node?.get(GEOMETRY_KEY.PARAMS) as Y.Map<unknown> | undefined;
  const ops = params?.get('ops') as Y.Array<CSGOp> | undefined;
  return ops ? ops.toArray() : [];
}

/** Append one CSG op. Concurrent appends interleave per Y.Array semantics. */
export function appendCSGOp(doc: Y.Doc, geomId: string, op: CSGOp): number {
  const ops = ensureCSGTree(doc, geomId);
  ops.push([op]);
  return ops.length - 1;
}

/** Insert a CSG op at a specific index. */
export function insertCSGOp(doc: Y.Doc, geomId: string, index: number, op: CSGOp): void {
  const ops = ensureCSGTree(doc, geomId);
  ops.insert(Math.max(0, Math.min(index, ops.length)), [op]);
}

/**
 * Remove a CSG op by `opId`. Returns true if found and removed.
 *
 * We search by opId rather than index so concurrent inserts elsewhere
 * don't shift the target.
 */
export function removeCSGOp(doc: Y.Doc, geomId: string, opId: string): boolean {
  const ops = ensureCSGTree(doc, geomId);
  const arr = ops.toArray();
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].opId === opId) {
      ops.delete(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Reorder a CSG op (move by opId to a new index). Implemented as
 * delete-then-insert; the underlying CRDT semantics keep concurrent
 * reorder + reorder visible as the last-applied wins (ordering is what
 * the user is *for sure* fighting over).
 */
export function moveCSGOp(doc: Y.Doc, geomId: string, opId: string, toIndex: number): boolean {
  const ops = ensureCSGTree(doc, geomId);
  const arr = ops.toArray();
  const idx = arr.findIndex((o) => o.opId === opId);
  if (idx < 0) return false;
  const [op] = arr.splice(idx, 1);
  doc.transact(() => {
    ops.delete(idx, 1);
    ops.insert(Math.max(0, Math.min(toIndex, ops.length)), [op]);
  });
  return true;
}
