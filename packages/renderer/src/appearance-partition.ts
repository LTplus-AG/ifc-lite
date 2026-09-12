/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Matches the native face-mask plan's aggregate ordinal budget. */
const MAX_PARTITION_TRIANGLES = 500_000;

/** One item on either side of a partition: the triangle ordinals of a shared
 * reference surface it carries, in its own triangle order. */
export interface AppearancePartitionPart {
  /** Unique within this side; geometryItemId may repeat across fragments. */
  readonly partId: number;
  readonly geometryItemId: number;
  readonly triangles: readonly number[];
}
/**
 * A face-masked appearance replaces one owner's items with several items that
 * together carry exactly the same triangle corners (#4404): the textured face
 * set and the retained face set of an evaluated occurrence. Both sides name
 * every ordinal of one reference surface exactly once, so the same record
 * inverted describes the join that Undo performs.
 */
export interface AppearancePartition {
  /** Canonical full surface whose triangle ordinals every side partitions. */
  readonly sourceGeometryItemId: number;
  readonly triangleCount: number;
  readonly before: readonly AppearancePartitionPart[];
  readonly after: readonly AppearancePartitionPart[];
}

export function invertAppearancePartition(partition: AppearancePartition): AppearancePartition {
  return { ...partition, before: partition.after, after: partition.before };
}

export function freezeAppearancePartition(partition: AppearancePartition): AppearancePartition {
  const side = (parts: readonly AppearancePartitionPart[]) => Object.freeze(parts.map(part =>
    Object.freeze({ partId: part.partId, geometryItemId: part.geometryItemId, triangles: Object.freeze([...part.triangles]) })));
  return Object.freeze({ sourceGeometryItemId: partition.sourceGeometryItemId, triangleCount: partition.triangleCount,
    before: side(partition.before), after: side(partition.after) });
}

function sameFrame(a: MeshData, b: MeshData): boolean {
  for (const key of ['origin', 'localToWorld'] as const) {
    const av = a[key], bv = b[key];
    if (av === undefined || bv === undefined) { if (av !== bv) return false; }
    else if (av.length !== bv.length || av.some((value, i) => value !== bv[i])) return false;
  }
  return true;
}

/** Items appear in declaration order; part identity, rather than IFC item id, is unique. */
function checkSide(side: readonly AppearancePartitionPart[], parts: readonly MeshData[], label: string): void {
  if (!side.length || side.length !== parts.length) throw new Error(`Appearance partition ${label} does not name every part`);
  const seen = new Set<number>();
  side.forEach((entry, index) => {
    if (!Number.isSafeInteger(entry.partId) || entry.partId < 0 || seen.has(entry.partId)
      || !Number.isSafeInteger(entry.geometryItemId) || entry.geometryItemId <= 0
      || parts[index].geometryItemId !== entry.geometryItemId) throw new Error(`Appearance partition ${label} item identity does not match its part`);
    seen.add(entry.partId);
    if (entry.triangles.length * 3 !== parts[index].indices.length) throw new Error(`Appearance partition ${label} triangle count does not match its part`);
    const source = parts[index].appearanceSource;
    if (!source || source.indices !== parts[index].indices || source.sourceIndices.length % 3
      || source.cornerIndices && source.cornerIndices.length !== parts[index].indices.length) {
      throw new Error(`Appearance partition ${label} has invalid full-surface provenance`);
    }
    entry.triangles.forEach((ordinal, triangle) => {
      for (let corner = 0; corner < 3; corner++) {
        if ((source.cornerIndices?.[triangle * 3 + corner] ?? triangle * 3 + corner) !== ordinal * 3 + corner) {
          throw new Error(`Appearance partition ${label} part identity does not match its canonical triangles`);
        }
      }
    });
  });
}

/** Reference corner -> position, from one side of the partition. */
function referenceCorners(side: readonly AppearancePartitionPart[], parts: readonly MeshData[], label: string): Map<number, readonly [number, number, number]> {
  const corners = new Map<number, readonly [number, number, number]>();
  side.forEach((entry, index) => {
    const part = parts[index];
    entry.triangles.forEach((ordinal, triangle) => {
      if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error(`Appearance partition ${label} names an invalid triangle`);
      for (let corner = 0; corner < 3; corner++) {
        const reference = ordinal * 3 + corner;
        if (corners.has(reference)) throw new Error(`Appearance partition ${label} names a triangle twice`);
        const vertex = part.indices[triangle * 3 + corner] * 3;
        if (vertex + 2 >= part.positions.length) throw new Error(`Appearance partition ${label} part index is out of range`);
        corners.set(reference, [part.positions[vertex], part.positions[vertex + 1], part.positions[vertex + 2]]);
      }
    });
  });
  return corners;
}

/**
 * Exact corner-for-corner equivalence between the two sides. Positions, the
 * placement frame, ownership and the reference coverage must be identical;
 * only shading normals and appearance attributes may differ.
 */
export function validateAppearancePartition(partition: AppearancePartition, before: readonly MeshData[], after: readonly MeshData[]): void {
  if (!Number.isSafeInteger(partition.sourceGeometryItemId) || partition.sourceGeometryItemId <= 0
    || !Number.isSafeInteger(partition.triangleCount) || partition.triangleCount <= 0
    || partition.triangleCount > MAX_PARTITION_TRIANGLES
    || partition.before.length > partition.triangleCount || partition.after.length > partition.triangleCount) {
    throw new Error('Appearance partition full-surface identity is invalid');
  }
  checkSide(partition.before, before, 'original');
  checkSide(partition.after, after, 'replacement');
  const sourceIndices = before[0].appearanceSource!.sourceIndices;
  if (sourceIndices.length !== partition.triangleCount * 3
    || [...before, ...after].some(part => part.appearanceSource!.sourceIndices !== sourceIndices)
    || !(before.every(part => part.geometryItemId === partition.sourceGeometryItemId)
      || after.every(part => part.geometryItemId === partition.sourceGeometryItemId))) {
    throw new Error('Appearance partition full-surface provenance does not match its source item');
  }
  const owner = before[0];
  for (const part of [...before, ...after]) {
    if (part.expressId !== owner.expressId || (part.modelIndex ?? 0) !== (owner.modelIndex ?? 0) || part.entityIds
      || !sameFrame(part, owner)) throw new Error('Appearance partition cannot change ownership or placement');
    if (part.normals.length !== part.positions.length || !part.normals.every(Number.isFinite)) throw new Error('Appearance partition part normals are invalid');
  }
  const original = referenceCorners(partition.before, before, 'original');
  const replacement = referenceCorners(partition.after, after, 'replacement');
  if (original.size !== partition.triangleCount * 3 || replacement.size !== original.size
    || [...original.keys()].some(reference => reference >= partition.triangleCount * 3)) {
    throw new Error('Appearance partition does not provide disjoint complete full-surface coverage');
  }
  for (const [reference, position] of original) {
    const other = replacement.get(reference);
    if (!other || other[0] !== position[0] || other[1] !== position[1] || other[2] !== position[2]) {
      throw new Error('Appearance partition changes triangle geometry');
    }
  }
}
