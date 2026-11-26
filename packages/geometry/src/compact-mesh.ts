/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact meshes (`MeshData.compact`): what every bundle carries.
 *
 * Reading a compact mesh's records (decoding it, turning a worker batch into
 * shells) lives in compact-shell.ts, which `loadCompactGeometry` fetches on
 * demand. This module is the small remainder code needs whether or not that
 * ever happens: telling a compact mesh from an f32 one, counting it without
 * decoding it, copying it, and turning it into an ordinary mesh.
 *
 * Until `loadCompactGeometry` has resolved, no worker is asked for compact
 * records (`geometry-worker-init.ts`), so no compact mesh exists.
 */

import { compactRow, type CompactPayload } from './compact-geometry.js';
import type { MeshData } from './types.js';

/** The three properties of a compact mesh that decode on first read. */
export const GEOMETRY_KEYS = ['positions', 'normals', 'indices'] as const;

type CompactShellModule = typeof import('./compact-shell.js');
let shell: CompactShellModule | undefined;

/**
 * Fetch the code that reads compact records. A host awaits this before a load
 * that sets `compactCellSize`; without it the workers are not asked for
 * compact records and the load delivers f32 meshes.
 */
export async function loadCompactGeometry(): Promise<void> {
  shell ??= await import('./compact-shell.js');
}

/** Whether `loadCompactGeometry` has resolved. */
export function compactGeometryLoaded(): boolean {
  return shell !== undefined;
}

/**
 * Main side: turn each mesh a worker tagged with a row into a compact shell
 * over its payload (in place). A no-op for a batch without payloads.
 */
export function adoptCompactMeshes(meshes: readonly MeshData[], payloads: readonly CompactPayload[] | undefined): void {
  if (!payloads || payloads.length === 0) return;
  // Workers encode only once the module is loaded, so a batch with payloads implies it.
  if (!shell) throw new Error('compact payloads before loadCompactGeometry()');
  shell.adoptCompactMeshes(meshes, payloads);
}

/** The part of `CoordinateHandler` a streamed batch goes through. */
interface BatchBoundsHandler {
  processMeshesIncremental(batch: MeshData[]): void;
  getOriginShift(): { x: number; y: number; z: number };
  shiftPositions(positions: Float32Array, shift: { x: number; y: number; z: number }): void;
}

/** `handler.processMeshesIncremental(meshes)`, without decoding a compact shell for its bounds. */
export function processBatchBounds(handler: BatchBoundsHandler, meshes: MeshData[]): void {
  if (shell) shell.processBatchBounds(handler, meshes);
  else handler.processMeshesIncremental(meshes);
}

const hydrations = { meshes: 0, triangles: 0 };

/** Record one compact mesh decoded to f32 (compact-shell.ts). */
export function noteCompactHydration(triangles: number): void {
  hydrations.meshes++;
  hydrations.triangles += triangles;
}

/** How many compact meshes have been decoded to f32 in this realm, and their triangles. */
export function compactHydrationStats(): { meshes: number; triangles: number } {
  return { ...hydrations };
}

/** A shallow copy that keeps a compact shell a shell (a spread would decode it). */
export function copyMeshShell(mesh: MeshData): MeshData {
  return mesh.compact ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(mesh)) as MeshData : { ...mesh };
}

/**
 * Make a compact shell an ordinary f32 mesh, in place: decode it (once per
 * shell, shared with its copies) and drop its row. No-op for any other mesh.
 */
export function materializeCompactMesh(mesh: MeshData): void {
  if (!mesh.compact) return;
  for (const key of GEOMETRY_KEYS) {
    Object.defineProperty(mesh, key, { value: mesh[key], enumerable: true, configurable: true, writable: true });
  }
  delete mesh.compact;
}

/** Triangles a mesh draws, without decoding a compact one. */
export function meshTriangleCount(mesh: Pick<MeshData, 'indices' | 'compact'>): number {
  return mesh.compact ? compactRow(mesh.compact).indexCount / 3 : mesh.indices.length / 3;
}

/** Vertices a mesh stores (welded ones for a compact mesh), without decoding it. */
export function meshVertexCount(mesh: Pick<MeshData, 'positions' | 'compact'>): number {
  return mesh.compact ? compactRow(mesh.compact).vertexCount : mesh.positions.length / 3;
}

/** `materializeCompactMesh` over a list; returns the list. */
export function materializeCompactMeshes(meshes: MeshData[]): MeshData[] {
  for (const mesh of meshes) if (mesh.compact) materializeCompactMesh(mesh);
  return meshes;
}
