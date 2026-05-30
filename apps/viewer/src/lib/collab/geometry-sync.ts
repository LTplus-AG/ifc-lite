/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry hydration via content-addressed mesh blobs (plan §4.2 — option b).
 *
 * Owner: encode each tessellated `MeshData`, store it as a blob (the blob hash
 * is the geomId — identical meshes dedupe), and attach a `GeometryRef` to the
 * owning GUID entity in the Y.Doc. Recipient: walk entities' `GeometryRef`s,
 * fetch the blobs, and decode back to `MeshData[]` for the renderer.
 *
 * The collab runtime + blob store are injected so this pulls no collab code
 * eagerly. Re-tessellation (the lighter parametric path, plan §4.2 option a)
 * is a follow-up; mesh blobs are the universal fallback that works for any
 * model including imported meshes.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { BlobStore, CollabSession } from '@ifc-lite/collab';
import { decodeMesh, encodeMesh } from './mesh-codec';

/** The collab doc + geometry helpers this module needs (injected). */
export interface CollabGeomApi {
  createGeometry(
    doc: CollabSession['doc'],
    geomId: string,
    opts: { type: 'mesh'; source: string; blobHash?: string },
  ): unknown;
  setGeometryRef(doc: CollabSession['doc'], path: string, ref: { geomId: string }): void;
  getGeometryRef(doc: CollabSession['doc'], path: string): { geomId: string } | undefined;
  getGeometry(doc: CollabSession['doc'], geomId: string): { get(key: string): unknown } | undefined;
  iterEntities(doc: CollabSession['doc']): IterableIterator<[string, unknown]>;
}

/**
 * Seed tessellated meshes into the room as blobs + per-entity `GeometryRef`s.
 * `pathFor` maps a mesh's `expressId` to its GUID entity path (skipped when it
 * returns null). Returns the number of meshes seeded.
 */
export async function seedGeometryToRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
  meshes: readonly MeshData[],
  pathFor: (expressId: number) => string | null,
): Promise<number> {
  let count = 0;
  for (const mesh of meshes) {
    const path = pathFor(mesh.expressId);
    if (!path) continue;
    const meta = await blobStore.put(encodeMesh(mesh), 'application/octet-stream');
    const geomId = meta.hash; // content-addressed → identical meshes dedupe
    session.transact(() => {
      api.createGeometry(session.doc, geomId, { type: 'mesh', source: 'mesh-blob', blobHash: meta.hash });
      api.setGeometryRef(session.doc, path, { geomId });
    });
    count++;
  }
  return count;
}

/**
 * Reconstruct `MeshData[]` from the room's geometry blobs. Used by a recipient
 * that joined a seed-into-room link with no source file. Missing blobs are
 * skipped (the seed may still be syncing).
 */
export async function hydrateGeometryFromRoom(
  api: CollabGeomApi,
  session: CollabSession,
  blobStore: BlobStore,
): Promise<MeshData[]> {
  const out: MeshData[] = [];
  for (const [path] of api.iterEntities(session.doc)) {
    const ref = api.getGeometryRef(session.doc, path);
    if (!ref) continue;
    const node = api.getGeometry(session.doc, ref.geomId);
    const blobHash = node?.get('blobHash');
    if (typeof blobHash !== 'string') continue;
    const bytes = await blobStore.get(blobHash);
    if (!bytes) continue;
    out.push(decodeMesh(bytes));
  }
  return out;
}
