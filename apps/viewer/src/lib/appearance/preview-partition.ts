/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { equivalentAppearanceGeometry, invertAppearancePartition, validateAppearancePartition } from '@ifc-lite/renderer';
import type { AppearanceChange, AppearancePartition } from '@ifc-lite/renderer';
import type { AppearancePlan } from './planner-types.js';
import type { AppearancePreviewImage, AppearancePreviewParts } from './preview.js';

type Conversion = NonNullable<AppearancePlan['conversions']>[number];
type Item = AppearancePlan['items'][number];
type ExpandCorners = (mesh: MeshData, sourceIndices: readonly number[], cornerUvs: readonly number[], targetIndices: Uint32Array,
  targetCornerNormals: readonly number[], targetVertexCount: number) => MeshData;
const MAX_PARTITION_TRIANGLES = 500_000;

/** The accepted mask as ascending full-surface triangle ordinals;
 * `undefined` for a whole-surface conversion (#4404). */
export function maskedSplit(conversion: Conversion): { masked: readonly number[] } | undefined {
  const { maskedTriangles, retainedGeometryItemId } = conversion;
  if (maskedTriangles === undefined && retainedGeometryItemId === undefined) return undefined;
  const count = conversion.sourceIndices.length / 3;
  if (!maskedTriangles || !Number.isSafeInteger(retainedGeometryItemId) || retainedGeometryItemId! <= 0
    || !Number.isSafeInteger(count) || count <= 0 || count > MAX_PARTITION_TRIANGLES
    || retainedGeometryItemId === conversion.geometryItemId || !maskedTriangles.length || maskedTriangles.length >= count
    || maskedTriangles.some((ordinal, index) => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= count
      || (index > 0 && ordinal <= maskedTriangles[index - 1]))) {
    throw new Error(`Invalid native face mask provenance for IFC object #${conversion.productId}.`);
  }
  return { masked: maskedTriangles };
}

function corners(source: MeshData, ordinals: readonly number[]): Uint32Array {
  const indices = new Uint32Array(ordinals.length * 3);
  ordinals.forEach((ordinal, triangle) => {
    for (let corner = 0; corner < 3; corner++) indices[triangle * 3 + corner] = source.indices[ordinal * 3 + corner];
  });
  return indices;
}

/**
 * One masked conversion becomes two parts of the same owner: the textured
 * face set with the planned UVs and the retained face set with the source
 * colour, over the original's corners. The partition record lets the renderer
 * prove corner-for-corner equivalence and lets history join them again.
 */
export function bindMaskedConversionParts(options: {
  originals: readonly MeshData[]; conversion: Conversion; item: Item; sourceGeometryItemId: number;
  texturedItemId: number; retainedItemId: number;
  image: AppearancePreviewImage; textureId: number; expandCorners: ExpandCorners;
}): { parts: MeshData[]; partition: AppearancePartition } {
  const { originals, conversion, item } = options;
  const split = maskedSplit(conversion);
  if (!split || !originals.length) throw new Error('Invalid native occurrence conversion provenance.');
  const full = originals[0].appearanceSource?.sourceIndices;
  if (!full || originals.length > conversion.sourceIndices.length / 3
    || full.length !== conversion.sourceIndices.length
    || conversion.sourceIndices.some((index, corner) => index !== full[corner])) {
    throw new Error(`The geometry of IFC object #${conversion.productId} changed. Reload it before applying appearance.`);
  }
  const seenCorners = new Uint8Array(conversion.sourceIndices.length);
  const fragments = originals.map((original) => {
    const source = original.appearanceSource;
    if (!source || source.kind !== 'canonical-item' || source.indices !== original.indices
      || original.geometryItemId !== options.sourceGeometryItemId
      || source.sourceIndices.length !== full.length
      || original.indices.length % 3 !== 0
      || (originals.length > 1 && !source.cornerIndices)) {
      throw new Error(`The geometry of IFC object #${conversion.productId} changed. Reload it before applying appearance.`);
    }
    const canonicalCorners = source.cornerIndices ?? Uint32Array.from({ length: original.indices.length }, (_, i) => i);
    if (canonicalCorners.length !== original.indices.length) throw new Error('Invalid streamed appearance corner provenance.');
    const triangles: number[] = [];
    for (let local = 0; local < original.indices.length; local += 3) {
      const first = canonicalCorners[local];
      if (first % 3 || canonicalCorners[local + 1] !== first + 1 || canonicalCorners[local + 2] !== first + 2
        || first + 2 >= seenCorners.length) throw new Error('Invalid streamed appearance triangle provenance.');
      for (let corner = first; corner < first + 3; corner++) {
        if (source.sourceIndices[corner] !== full[corner]) throw new Error('Invalid streamed appearance full-surface provenance.');
        if (seenCorners[corner]) throw new Error('Streamed appearance fragments overlap.');
        seenCorners[corner] = 1;
      }
      triangles.push(first / 3);
    }
    return { original, triangles };
  });
  if (seenCorners.some(value => value !== 1)) {
    throw new Error(`The geometry of IFC object #${conversion.productId} changed. Reload it before applying appearance.`);
  }
  if (item.sourceIndices.length !== split.masked.length * 3) throw new Error('Invalid native occurrence conversion provenance.');
  const maskedRank = new Uint32Array(conversion.sourceIndices.length / 3);
  split.masked.forEach((ordinal, rank) => { maskedRank[ordinal] = rank + 1; });
  const parts: MeshData[] = [];
  const before: AppearancePartition['before'][number][] = [];
  const after: AppearancePartition['after'][number][] = [];
  fragments.forEach(({ original, triangles }, fragment) => {
    before.push({ partId: fragment, geometryItemId: original.geometryItemId!, triangles });
    const local = (wanted: boolean) => triangles.map((ordinal, triangle) => ({ ordinal, triangle }))
      .filter(({ ordinal }) => (maskedRank[ordinal] !== 0) === wanted);
    const masked = local(true), retained = local(false);
    if (masked.length) {
      const indices = corners(original, masked.map(({ triangle }) => triangle));
      const cornerMap = Uint32Array.from(masked.flatMap(({ ordinal }) => [ordinal * 3, ordinal * 3 + 1, ordinal * 3 + 2]));
      const ranks = masked.map(({ ordinal }) => maskedRank[ordinal] - 1);
      const take = (values: ArrayLike<number>, width: number) => ranks.flatMap(rank =>
        Array.from({ length: 3 * width }, (_, offset) => values[rank * 3 * width + offset]));
      const temporary: MeshData = { ...original, geometryItemId: options.texturedItemId, indices,
        appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
      const textured = options.expandCorners(temporary, Array.from(indices), take(item.previewCornerUvs, 2),
        Uint32Array.from(take(item.targetIndices, 1)), take(item.targetCornerNormals, 3), item.targetVertexCount);
      textured.appearanceSource = { kind: 'canonical-item', indices: textured.indices, sourceIndices: full, cornerIndices: cornerMap };
      parts.push({ ...textured, color: [1, 1, 1, 1], shadingColor: undefined, texture: undefined, textureBitmap: options.image.bitmap,
        textureRef: { textureId: options.textureId, url: options.image.imageUri, repeatS: options.image.repeatS, repeatT: options.image.repeatT } });
      after.push({ partId: after.length, geometryItemId: options.texturedItemId, triangles: masked.map(({ ordinal }) => ordinal) });
    }
    if (retained.length) {
      const indices = corners(original, retained.map(({ triangle }) => triangle));
      const cornerIndices = Uint32Array.from(retained.flatMap(({ ordinal }) => [ordinal * 3, ordinal * 3 + 1, ordinal * 3 + 2]));
      parts.push({ ...original, geometryItemId: options.retainedItemId, indices,
        appearanceSource: { kind: 'canonical-item', indices, sourceIndices: full, cornerIndices } });
      after.push({ partId: after.length, geometryItemId: options.retainedItemId, triangles: retained.map(({ ordinal }) => ordinal) });
    }
  });
  const partition: AppearancePartition = {
    sourceGeometryItemId: options.sourceGeometryItemId,
    triangleCount: conversion.sourceIndices.length / 3,
    before,
    after,
  };
  return { parts, partition };
}

/** History of a partitioned owner: the recorded side must be resident exactly;
 * the other side is re-staged through the inverted partition. */
export function partitionHistoryParts(change: AppearanceChange, current: readonly MeshData[] | undefined,
  direction: 'undo' | 'redo'): AppearancePreviewParts {
  const partition = change.partition!;
  const target = direction === 'undo' ? change.before : change.after;
  const expectedCurrent = direction === 'undo' ? change.after : change.before;
  if (!current || current.length !== expectedCurrent.length || current.some((mesh, index) =>
    mesh.geometryItemId !== expectedCurrent[index].geometryItemId || !equivalentAppearanceGeometry(mesh, expectedCurrent[index]))) {
    throw new Error('Cannot restore appearance because current geometry or shading changed.');
  }
  const transition = direction === 'undo' ? invertAppearancePartition(partition) : partition;
  try { validateAppearancePartition(transition, current, target); }
  catch (cause) { throw new Error('Cannot restore appearance because current geometry or shading changed.', { cause }); }
  // Every part of a partitioned owner shares the first live part's frame and metadata.
  const live = current[0];
  const parts = target.map(appearance => ({ ...live, geometryItemId: appearance.geometryItemId, positions: appearance.positions,
    normals: appearance.normals, indices: appearance.indices, appearanceSource: appearance.appearanceSource, color: appearance.color,
    shadingColor: appearance.shadingColor, uvs: appearance.uvs, texture: appearance.texture, textureRef: appearance.textureRef,
    textureBitmap: appearance.textureBitmap }));
  const instanced = direction === 'undo' ? change.beforeInstanced : change.afterInstanced;
  const materializedOriginals = change.beforeInstanced ? change.before : change.afterInstanced ? change.after : undefined;
  return { globalId: change.owner.expressId, modelIndex: change.owner.modelIndex, parts, instanced, materializedOriginals,
    partition: transition };
}
