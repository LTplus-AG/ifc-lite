/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

/**
 * `Scene.getMeshData`'s singular result for an entity with several pieces: one
 * mesh concatenating them, in `mergedOrigin`'s frame when given (else each
 * piece's local positions as they are). `null` when the pieces' colours differ:
 * merging would paint every piece the first one's colour.
 */
export function mergeSameColorPieces(
  pieces: readonly MeshData[],
  expressId: number,
  mergedOrigin: [number, number, number] | undefined,
): MeshData | null {
  // Check if all pieces have the same color (within tolerance)
  // This handles multi-material elements like windows (frame vs glass)
  const firstColor = pieces[0].color;
  const colorTolerance = 0.01; // Allow small floating point differences
  const allSameColor = pieces.every(piece => {
    const c = piece.color;
    return Math.abs(c[0] - firstColor[0]) < colorTolerance &&
           Math.abs(c[1] - firstColor[1]) < colorTolerance &&
           Math.abs(c[2] - firstColor[2]) < colorTolerance &&
           Math.abs(c[3] - firstColor[3]) < colorTolerance;
  });

  // If colors differ, do not merge: the caller returns the first piece, which
  // preserves correct per-piece colors for multi-material elements.
  // Callers can use getMeshDataPieces() if they need all pieces
  if (!allSameColor) {
    return null;
  }

  // All pieces have same color - safe to merge
  // Calculate total sizes
  let totalPositions = 0;
  let totalIndices = 0;
  for (const piece of pieces) {
    totalPositions += piece.positions.length;
    totalIndices += piece.indices.length;
  }

  // Create merged arrays
  const mergedPositions = new Float32Array(totalPositions);
  const mergedNormals = new Float32Array(totalPositions);
  const mergedIndices = new Uint32Array(totalIndices);

  let posOffset = 0;
  let idxOffset = 0;
  let vertexOffset = 0;
  for (const piece of pieces) {
    if (mergedOrigin) {
      const ox = (piece.origin?.[0] ?? 0) - mergedOrigin[0], oy = (piece.origin?.[1] ?? 0) - mergedOrigin[1], oz = (piece.origin?.[2] ?? 0) - mergedOrigin[2];
      for (let i = 0; i < piece.positions.length; i += 3) {
        mergedPositions[posOffset + i] = piece.positions[i] + ox;
        mergedPositions[posOffset + i + 1] = piece.positions[i + 1] + oy;
        mergedPositions[posOffset + i + 2] = piece.positions[i + 2] + oz;
      }
    } else {
      mergedPositions.set(piece.positions, posOffset);
    }
    mergedNormals.set(piece.normals, posOffset);
    // Copy indices with offset
    for (let i = 0; i < piece.indices.length; i++) {
      mergedIndices[idxOffset + i] = piece.indices[i] + vertexOffset;
    }

    posOffset += piece.positions.length;
    idxOffset += piece.indices.length;
    vertexOffset += piece.positions.length / 3;
  }

  // Return merged MeshData (all pieces have same color)
  return {
    expressId,
    modelIndex: pieces[0].modelIndex,  // Preserve modelIndex for multi-model support
    positions: mergedPositions,
    normals: mergedNormals,
    indices: mergedIndices,
    color: firstColor,
    ifcType: pieces[0].ifcType,
    ...(mergedOrigin ? { origin: mergedOrigin } : {}),
  };
}
