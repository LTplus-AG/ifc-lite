/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { meshTriangleCount, meshVertexCount } from '@ifc-lite/geometry/compact';
import { registerCpuMeshCopy } from './geometry-cpu-aliases';

// The bounded-memory release callback runs after GPU upload. Retain only
// identity, not the buffers it explicitly releases. Object lifetime is weak.
const released = new WeakMap<MeshData, { owner: number; item: number | undefined }>();
// Counted without reading a compact mesh's arrays: a read decodes it, and the decode stays (lane L9: every
// compact mesh of a load was decoded here, by the symbolic-annotation fill lookup, +7 to +106 MiB JS heap).
const nonempty = (mesh: MeshData) => meshTriangleCount(mesh) >= 1 && meshVertexCount(mesh) >= 3;

// Triangle/vertex counts the running geometryResult totals still include for a
// released mesh, so removing it later subtracts what was added (#4874).
// Field markers are the assigned zero-byte arrays, never the populated arrays.
// Replacement empties must not inherit the previous geometry counts (#6584).
type ReleasedCounts = MeshGeometryCounts & { positions?: Float32Array; indices?: Uint32Array };
const releasedCounts = new WeakMap<MeshData, ReleasedCounts>();

export interface MeshGeometryCounts { triangles: number; vertices: number }

export function retainReleasedMeshProvenance(
  mesh: MeshData, cleared: { positions?: Float32Array; indices?: Uint32Array } = {},
): void {
  if (nonempty(mesh)) released.set(mesh, { owner: mesh.expressId, item: mesh.geometryItemId });
  // Only a populated mesh has counts to retain: releasing an already-released
  // mesh must not overwrite them with zero.
  if (mesh.indices.length > 0 || mesh.positions.length > 0) {
    releasedCounts.set(mesh, { ...releasedCounts.get(mesh), ...meshGeometryCounts(mesh), ...cleared });
  }
}

/**
 * Carry a released mesh's retained provenance and counts onto a copy of it
 * (e.g. `updateMeshColors`' `{ ...mesh, color }`), whose buffers are just as
 * empty but which the WeakMaps would not otherwise know. Returns `copy`.
 */
/**
 * Copy -> the meshes it descends from, nearest first, flattened and WEAK (#10264, #6584):
 * a live copy never keeps an earlier wrapper (or its buffers) alive. The root, the
 * canonical store mesh the store list holds, is always kept as the last entry.
 */
const releasedSources = new WeakMap<MeshData, readonly WeakRef<MeshData>[]>();
const MAX_ANCESTRY = 8;

/** The meshes a released copy descends from that are still alive, nearest first. */
export function* releasedAncestry(mesh: MeshData): Iterable<MeshData> {
  const seen = new Set<MeshData>([mesh]);
  for (const ref of releasedSources.get(mesh) ?? []) {
    const at = ref.deref();
    if (at && !seen.has(at)) { seen.add(at); yield at; }
  }
}

function recordAncestry(source: MeshData, copy: MeshData): void {
  const inherited = (releasedSources.get(source) ?? []).filter((ref) => ref.deref() !== undefined && ref.deref() !== copy);
  let chain = [new WeakRef(source), ...inherited];
  if (chain.length > MAX_ANCESTRY) chain = [...chain.slice(0, MAX_ANCESTRY - 1), chain[chain.length - 1]];
  releasedSources.set(copy, chain);
}

export function carryReleasedMesh(source: MeshData, copy: MeshData): MeshData {
  registerCpuMeshCopy(source, copy);
  // A copy can outlive a later release of its shared buffers. Record its
  // source while resident too; release clears both registered aliases.
  if (source !== copy) recordAncestry(source, copy);
  const provenance = released.get(source);
  if (provenance) released.set(copy, provenance);
  const counts = releasedCounts.get(source);
  if (counts) releasedCounts.set(copy, counts);
  return copy;
}

/** Whether this mesh's geometry arrays are exactly the ones a CPU release assigned (#10264). */
export function isReleasedMesh(mesh: MeshData): boolean {
  const retained = releasedCounts.get(mesh);
  return retained !== undefined && (retained.positions === mesh.positions || retained.indices === mesh.indices);
}

/** Counts this mesh contributes to geometryResult totals, live or as retained at release. */
export function meshGeometryCounts(mesh: MeshData): MeshGeometryCounts {
  if (mesh.compact) return { triangles: meshTriangleCount(mesh), vertices: meshVertexCount(mesh) }; // never released: its arrays decode on read
  const retained = releasedCounts.get(mesh);
  return {
    triangles: mesh.indices.length > 0 ? mesh.indices.length / 3 : retained?.indices === mesh.indices ? retained.triangles : 0,
    vertices: mesh.positions.length > 0 ? mesh.positions.length / 3 : retained?.positions === mesh.positions ? retained.vertices : 0,
  };
}

export function hasMeshGeometryProvenance(mesh: MeshData): boolean {
  if (nonempty(mesh)) {
    released.delete(mesh); // New populated geometry supersedes any previous release.
    return true;
  }
  const prior = released.get(mesh);
  return prior !== undefined && prior.owner === mesh.expressId && prior.item === mesh.geometryItemId;
}

/**
 * What the scene draws (#10264): the list of its latest flat reshape, hydration or upload pass (later
 * appends grow it in place); a released device recovery rebuilds exactly this. `undefined` until one is
 * recorded: an EMPTY recorded list (every flat type hidden, instancing only) is a real answer, not a
 * missing one. Kept here, with the provenance every recorder already loads, so no separate chunk carries it.
 */
let sceneGeometry: readonly MeshData[] | undefined;
export function noteSceneGeometry(geometry: readonly MeshData[] | undefined): void { sceneGeometry = geometry; }
export function currentSceneGeometry(): readonly MeshData[] | undefined { return sceneGeometry; }
