/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { equivalentAppearanceGeometry, invertAppearancePartition } from '@ifc-lite/renderer';
import type { AppearanceChange, AppearancePartition } from '@ifc-lite/renderer';
import type { AppearancePlan } from './planner-types.js';
import type { AppearancePreviewImage, AppearancePreviewParts } from './preview.js';

type Conversion = NonNullable<AppearancePlan['conversions']>[number];
type Item = AppearancePlan['items'][number];
type ExpandCorners = (mesh: MeshData, sourceIndices: readonly number[], cornerUvs: readonly number[], targetIndices: Uint32Array,
  targetCornerNormals: readonly number[], targetVertexCount: number) => MeshData;

/** The accepted mask of a conversion as ascending source triangle ordinals and
 * their complement; `undefined` for a whole-surface conversion (#4404). */
export function maskedSplit(conversion: Conversion): { masked: number[]; retained: number[] } | undefined {
  const { maskedTriangles, retainedGeometryItemId } = conversion;
  if (maskedTriangles === undefined && retainedGeometryItemId === undefined) return undefined;
  const count = conversion.sourceIndices.length / 3;
  if (!maskedTriangles || !Number.isSafeInteger(retainedGeometryItemId) || retainedGeometryItemId! <= 0
    || retainedGeometryItemId === conversion.geometryItemId || !maskedTriangles.length || maskedTriangles.length >= count
    || maskedTriangles.some((ordinal, index) => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= count
      || (index > 0 && ordinal <= maskedTriangles[index - 1]))) {
    throw new Error(`Invalid native face mask provenance for IFC object #${conversion.productId}.`);
  }
  const selected = new Set(maskedTriangles);
  const retained: number[] = [];
  for (let ordinal = 0; ordinal < count; ordinal++) if (!selected.has(ordinal)) retained.push(ordinal);
  return { masked: [...maskedTriangles], retained };
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
  original: MeshData; conversion: Conversion; item: Item; texturedItemId: number; retainedItemId: number;
  image: AppearancePreviewImage; textureId: number; expandCorners: ExpandCorners;
}): { parts: MeshData[]; partition: AppearancePartition } {
  const { original, conversion, item } = options;
  const split = maskedSplit(conversion);
  const source = original.appearanceSource;
  if (!split) throw new Error('Invalid native occurrence conversion provenance.');
  if (source?.cornerIndices) {
    throw new Error(`Face selection needs the evaluated surface of IFC object #${conversion.productId} in one piece, but it renders in several pieces. Clear its face selection to texture the whole surface.`);
  }
  if (!source || source.kind !== 'canonical-item' || source.indices !== original.indices
    || original.indices.length !== conversion.sourceIndices.length
    || conversion.sourceIndices.some((index, corner) => index !== original.indices[corner])) {
    throw new Error(`The geometry of IFC object #${conversion.productId} changed. Reload it before applying appearance.`);
  }
  if (item.sourceIndices.length !== split.masked.length * 3) throw new Error('Invalid native occurrence conversion provenance.');
  const sub = (ordinals: readonly number[], geometryItemId: number): MeshData => {
    const indices = corners(original, ordinals);
    return { ...original, geometryItemId, indices, appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
  };
  const localTextured = options.expandCorners(sub(split.masked, options.texturedItemId), [...corners(original, split.masked)], item.previewCornerUvs,
    new Uint32Array(item.targetIndices), item.targetCornerNormals, item.targetVertexCount);
  const fullSourceIndices = source.sourceIndices;
  const provenance = (ordinals: readonly number[]) => Uint32Array.from(ordinals.flatMap(ordinal => [ordinal * 3, ordinal * 3 + 1, ordinal * 3 + 2]));
  const textured = { ...localTextured, appearanceSource: { ...localTextured.appearanceSource!, sourceIndices: fullSourceIndices,
    cornerIndices: provenance(split.masked) } };
  const retained = sub(split.retained, options.retainedItemId);
  retained.appearanceSource = { ...retained.appearanceSource!, sourceIndices: fullSourceIndices, cornerIndices: provenance(split.retained) };
  const parts: MeshData[] = [
    { ...textured, color: [1, 1, 1, 1], shadingColor: undefined, texture: undefined, textureBitmap: options.image.bitmap,
      textureRef: { textureId: options.textureId, url: options.image.imageUri, repeatS: options.image.repeatS, repeatT: options.image.repeatT } },
    { ...retained, color: [...original.color] as MeshData['color'], uvs: undefined, texture: undefined, textureRef: undefined, textureBitmap: undefined },
  ];
  const partition: AppearancePartition = {
    before: [{ geometryItemId: original.geometryItemId!, triangles: Array.from({ length: original.indices.length / 3 }, (_, ordinal) => ordinal) }],
    after: [{ geometryItemId: options.texturedItemId, triangles: split.masked }, { geometryItemId: options.retainedItemId, triangles: split.retained }],
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
  // Every part of a partitioned owner shares the first live part's frame and metadata.
  const live = current[0];
  const parts = target.map(appearance => ({ ...live, geometryItemId: appearance.geometryItemId, positions: appearance.positions,
    normals: appearance.normals, indices: appearance.indices, appearanceSource: appearance.appearanceSource, color: appearance.color,
    shadingColor: appearance.shadingColor, uvs: appearance.uvs, texture: appearance.texture, textureRef: appearance.textureRef,
    textureBitmap: appearance.textureBitmap }));
  const instanced = direction === 'undo' ? change.beforeInstanced : change.afterInstanced;
  const materializedOriginals = change.beforeInstanced ? change.before : change.afterInstanced ? change.after : undefined;
  return { globalId: change.owner.expressId, modelIndex: change.owner.modelIndex, parts, instanced, materializedOriginals,
    partition: direction === 'undo' ? invertAppearancePartition(partition) : partition };
}
