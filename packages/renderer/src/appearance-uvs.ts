/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Bind canonical final triangle corners, expanding welded vertices only for
 * appearance. Geometry coordinates and triangle order remain exactly unchanged. */
export function expandAppearanceCorners(
  mesh: MeshData,
  canonicalSourceIndices: ArrayLike<number>,
  canonicalCornerUvs: ArrayLike<number>,
  canonicalTargetIndices: ArrayLike<number>,
  canonicalTargetCornerNormals: ArrayLike<number>,
  canonicalTargetVertexCount: number,
): MeshData {
  const source = mesh.appearanceSource;
  if (
    !source ||
    source.kind !== 'canonical-item' ||
    source.indices !== mesh.indices ||
    mesh.geometryItemId === undefined ||
    mesh.entityIds ||
    mesh.indices.length % 3 !== 0 ||
    canonicalSourceIndices.length !== source.sourceIndices.length ||
    canonicalCornerUvs.length !== source.sourceIndices.length * 2 ||
    canonicalTargetIndices.length !== source.sourceIndices.length ||
    canonicalTargetCornerNormals.length !== source.sourceIndices.length * 3 ||
    (source.cornerIndices
      ? source.cornerIndices.length !== mesh.indices.length
      : mesh.indices.length !== source.sourceIndices.length)
  ) {
    throw new Error(
      'Appearance preview requires matching canonical corner provenance. Reload the IFC model.',
    );
  }
  for (let i = 0; i < canonicalSourceIndices.length; i++) {
    if (canonicalSourceIndices[i] !== source.sourceIndices[i])
      throw new Error('Appearance canonical source topology changed');
  }
  if (
    !Number.isSafeInteger(canonicalTargetVertexCount) ||
    canonicalTargetVertexCount <= 0 ||
    canonicalTargetVertexCount > 0x100000000
  )
    throw new Error('Appearance target vertex pool is invalid');
  for (let i = 0; i < canonicalTargetIndices.length; i++) {
    if (
      !Number.isSafeInteger(canonicalTargetIndices[i]) ||
      canonicalTargetIndices[i] < 0 ||
      canonicalTargetIndices[i] >= canonicalTargetVertexCount
    )
      throw new Error('Appearance target topology is invalid');
  }
  const targetIndices =
    canonicalTargetIndices instanceof Uint32Array
      ? canonicalTargetIndices
      : Uint32Array.from(canonicalTargetIndices);
  const count = mesh.indices.length;
  const positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3);
  const indices = new Uint32Array(count),
    uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const corner = source.cornerIndices?.[i] ?? i,
      vertex = mesh.indices[i];
    if (
      corner >= source.sourceIndices.length ||
      vertex * 3 + 2 >= mesh.positions.length ||
      vertex * 3 + 2 >= mesh.normals.length
    )
      throw new Error('Appearance source corner index is out of range');
    for (let axis = 0; axis < 3; axis++) {
      positions[i * 3 + axis] = mesh.positions[vertex * 3 + axis];
      // Canonical final weld representatives are already in renderer Y-up.
      normals[i * 3 + axis] = canonicalTargetCornerNormals[corner * 3 + axis];
      if (!Number.isFinite(normals[i * 3 + axis]))
        throw new Error('Appearance normals exceed the finite renderer range');
    }
    indices[i] = i;
    uvs[i * 2] = canonicalCornerUvs[corner * 2];
    uvs[i * 2 + 1] = canonicalCornerUvs[corner * 2 + 1];
    if (!Number.isFinite(uvs[i * 2]) || !Number.isFinite(uvs[i * 2 + 1])) {
      throw new Error('Appearance UVs exceed the finite renderer range');
    }
  }
  return {
    ...mesh,
    positions,
    normals,
    indices,
    uvs,
    appearanceSource: { ...source, indices, sourceIndices: targetIndices },
  };
}

/** Exact triangle-corner equivalence for history validation. Normal changes are
 * opt-in when applying canonical appearance shading; positions stay exact. */
export function equivalentAppearanceGeometry(
  a: MeshData,
  b: MeshData,
  options: { allowNormalChanges?: boolean } = {},
): boolean {
  for (const key of ['origin', 'localToWorld'] as const) {
    const av = a[key],
      bv = b[key];
    if (av === undefined || bv === undefined) {
      if (av !== bv) return false;
    } else if (
      av.length !== bv.length ||
      av.some((value, i) => value !== bv[i])
    ) {
      return false;
    }
  }
  if (
    a.positions === b.positions &&
    (options.allowNormalChanges || a.normals === b.normals) &&
    a.indices === b.indices
  )
    return true;
  if (
    !a.appearanceSource ||
    !b.appearanceSource ||
    a.appearanceSource.indices !== a.indices ||
    b.appearanceSource.indices !== b.indices ||
    a.indices.length !== b.indices.length ||
    a.appearanceSource.sourceIndices.length !==
      b.appearanceSource.sourceIndices.length
  )
    return false;
  for (let corner = 0; corner < a.indices.length; corner++) {
    if (
      (a.appearanceSource.cornerIndices?.[corner] ?? corner) !==
      (b.appearanceSource.cornerIndices?.[corner] ?? corner)
    )
      return false;
    for (let axis = 0; axis < 3; axis++) {
      const ai = a.indices[corner] * 3 + axis,
        bi = b.indices[corner] * 3 + axis;
      if (
        ai >= a.positions.length ||
        bi >= b.positions.length ||
        ai >= a.normals.length ||
        bi >= b.normals.length ||
        a.positions[ai] !== b.positions[bi] ||
        (!options.allowNormalChanges && a.normals[ai] !== b.normals[bi])
      )
        return false;
    }
  }
  return true;
}
