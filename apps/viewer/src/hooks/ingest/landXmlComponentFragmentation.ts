/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Credited triangle-boundary partitioning for LandXML renderer uploads. */

import type { MeshData } from '@ifc-lite/geometry';
import type { LandXmlGeometryComponent } from './landXmlComponentPlacement.js';

/** Keep room for envelope fields and provenance below the 512 KiB credit. */
export const MAX_LANDXML_COMPONENT_TRANSFER_BYTES = 384 * 1024;
export const MAX_LANDXML_COMPONENT_MESSAGE_BYTES = 448 * 1024;

function meshTransferBytes(mesh: MeshData): number {
  return mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
}

function chunkMesh(
  mesh: MeshData,
  faceSourceIds: readonly string[],
): Array<{ mesh: MeshData; renderedFaceSourceIds: string[] }> {
  if (meshTransferBytes(mesh) <= MAX_LANDXML_COMPONENT_TRANSFER_BYTES) {
    return [{ mesh, renderedFaceSourceIds: [...faceSourceIds] }];
  }
  if (mesh.indices.length % 3 !== 0 || (faceSourceIds.length !== 0 && faceSourceIds.length !== mesh.indices.length / 3)) {
    throw new Error('LandXML component has invalid triangle provenance for transport fragmentation');
  }
  const chunks: Array<{ mesh: MeshData; renderedFaceSourceIds: string[] }> = [];
  let positions: number[] = [];
  let normals: number[] = [];
  let indices: number[] = [];
  let provenance: string[] = [];
  let provenanceBytes = 0;
  let remap = new Map<number, number>();
  const flush = (): void => {
    if (indices.length === 0) return;
    chunks.push({
      mesh: {
        expressId: mesh.expressId,
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        indices: new Uint32Array(indices),
        color: mesh.color,
        ...(mesh.origin ? { origin: [...mesh.origin] as [number, number, number] } : {}),
      },
      renderedFaceSourceIds: provenance,
    });
    positions = [];
    normals = [];
    indices = [];
    provenance = [];
    provenanceBytes = 0;
    remap = new Map();
  };
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle++) {
    const source = [mesh.indices[triangle * 3]!, mesh.indices[triangle * 3 + 1]!, mesh.indices[triangle * 3 + 2]!];
    const newVertices = source.filter((index) => !remap.has(index));
    const sourceId = faceSourceIds[triangle];
    const sourceIdBytes = sourceId === undefined ? 0 : new TextEncoder().encode(sourceId).byteLength;
    const nextMeshBytes = (positions.length + newVertices.length * 3) * Float32Array.BYTES_PER_ELEMENT
      + (normals.length + newVertices.length * 3) * Float32Array.BYTES_PER_ELEMENT
      + (indices.length + 3) * Uint32Array.BYTES_PER_ELEMENT;
    const nextBytes = nextMeshBytes + provenanceBytes + sourceIdBytes;
    if (indices.length > 0 && (nextMeshBytes > MAX_LANDXML_COMPONENT_TRANSFER_BYTES || nextBytes > MAX_LANDXML_COMPONENT_MESSAGE_BYTES)) flush();
    const singleTriangleMeshBytes = 3 * 3 * Float32Array.BYTES_PER_ELEMENT * 2 + 3 * Uint32Array.BYTES_PER_ELEMENT;
    if (indices.length === 0 && (singleTriangleMeshBytes > MAX_LANDXML_COMPONENT_TRANSFER_BYTES || singleTriangleMeshBytes + sourceIdBytes > MAX_LANDXML_COMPONENT_MESSAGE_BYTES)) {
      throw new Error('LandXML triangle cannot fit in the credited component transport envelope');
    }
    for (const sourceIndex of source) {
      let targetIndex = remap.get(sourceIndex);
      if (targetIndex === undefined) {
        targetIndex = positions.length / 3;
        remap.set(sourceIndex, targetIndex);
        positions.push(mesh.positions[sourceIndex * 3]!, mesh.positions[sourceIndex * 3 + 1]!, mesh.positions[sourceIndex * 3 + 2]!);
        normals.push(mesh.normals[sourceIndex * 3]!, mesh.normals[sourceIndex * 3 + 1]!, mesh.normals[sourceIndex * 3 + 2]!);
      }
      indices.push(targetIndex);
    }
    if (sourceId !== undefined) {
      provenance.push(sourceId);
      provenanceBytes += sourceIdBytes;
    }
  }
  flush();
  return chunks;
}

/** Split a source component at triangle boundaries without changing provenance. */
export function fragmentLandXmlGeometryComponent(component: LandXmlGeometryComponent): LandXmlGeometryComponent[] {
  return chunkMesh(component.mesh, component.renderedFaceSourceIds).map((chunk) => ({
    ...component,
    mesh: chunk.mesh,
    renderedFaceSourceIds: chunk.renderedFaceSourceIds,
  }));
}
