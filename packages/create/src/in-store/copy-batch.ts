/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared selection, preview and atomic write for paste, array and Duplicate (#6232 D5). */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { copyProductInStore, copyRefusal, createCopyContext, productStoreyOrigin, type CopyContext, type CopyProductResult, type CopyTransform } from './copy-product.js';
import type { DuplicateInStoreOptions } from './duplicate.js';

/** Bound caller-supplied copy fan-out before allocating products/transforms. */
export const COPY_BATCH_LIMIT = 10_000;

/** Keep roots once; their openings, fillings and assembly parts travel with them. */
export function copySourcesInStore(ctx: CopyContext, ids: readonly number[]): { ids: number[] } | { refusal: string } {
  const hostOf = new Map<number, number>();
  for (const [host, openings] of ctx.voids) for (const { id } of openings) hostOf.set(id, host);
  const chosen = new Set(ids);
  const carried = (id: number): boolean => {
    const seen = new Set<number>();
    for (let up: number | undefined = id; up !== undefined && !seen.has(up); ) {
      seen.add(up);
      up = ctx.partOf.get(up) ?? hostOf.get(ctx.filledBy.get(up) ?? up);
      if (up !== undefined && chosen.has(up)) return true;
    }
    return false;
  };
  const kept = [...chosen].filter((id) => !carried(id));
  for (const id of kept) {
    const refusal = copyRefusal(ctx, id);
    if (refusal) return { refusal };
    try {
      if (!productStoreyOrigin(ctx, id)) return { refusal: `#${id} has no placement to copy from` };
    } catch (error) {
      return { refusal: error instanceof Error ? error.message : String(error) };
    }
  }
  return kept.length > 0 ? { ids: kept } : { refusal: 'Nothing to copy' };
}

/** Products a copy preview displays, including hosted fillings and assembly parts. */
export function copiedProductsInStore(ctx: CopyContext, ids: readonly number[]): number[] {
  const shown = new Set<number>();
  const pending = [...ids].reverse();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (shown.has(id)) continue;
    shown.add(id);
    const children = (ctx.voids.get(id) ?? []).flatMap(({ id: opening }) => (ctx.fills.get(opening) ?? []).map(({ id: filling }) => filling));
    children.push(...(ctx.parts.get(id) ?? []).flatMap((link) => link.parts));
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return [...shown];
}

export interface CopyBatchOptions {
  /** Duplicate's naming/randomness policy; displacement is supplied by transforms. */
  readonly duplicate?: Pick<DuplicateInStoreOptions, 'name' | 'guidRandom'>;
}

/**
 * Each transform copies each selected root, in transform-major order. All
 * graph writes succeed together or leave records, journal and allocator intact.
 * The same selection policy is applied at preview and commit: selected hosted
 * children never create a second independent copy.
 */
export function copyBatchInStore(
  store: IfcDataStore,
  editor: StoreEditor,
  ids: readonly number[],
  transforms: readonly CopyTransform[],
  options: CopyBatchOptions = {},
): readonly CopyProductResult[] {
  if (transforms.length * new Set(ids).size > COPY_BATCH_LIMIT) throw new Error(`A copy batch may contain at most ${COPY_BATCH_LIMIT} product copies`);
  if (transforms.length === 0) throw new Error('At least one copy transform is required');
  for (const transform of transforms) {
    if (transform.offset && (transform.offset.length !== 3 || !transform.offset.every(Number.isFinite))) throw new Error('Copy offset must contain three finite metre coordinates');
    if (transform.pivot && (transform.pivot.length !== 2 || !transform.pivot.every(Number.isFinite))) throw new Error('Copy pivot must contain two finite metre coordinates');
    if (transform.turn !== undefined && !Number.isFinite(transform.turn)) throw new Error('Copy turn must be finite radians');
    if (transform.targetStoreyId !== undefined && (!Number.isSafeInteger(transform.targetStoreyId) || transform.targetStoreyId <= 0)) throw new Error('Copy targetStoreyId must be a positive integer');
  }
  return editor.runAtomic((draft) => {
    const ctx = createCopyContext(store, draft, { guidRandom: options.duplicate?.guidRandom });
    for (const transform of transforms) {
      if (transform.targetStoreyId !== undefined && ctx.read(transform.targetStoreyId)?.type.toUpperCase() !== 'IFCBUILDINGSTOREY') throw new Error('Copy targetStoreyId must identify an IfcBuildingStorey in this model');
    }
    const sources = copySourcesInStore(ctx, ids);
    if ('refusal' in sources) throw new Error(sources.refusal);
    return transforms.flatMap((transform) => sources.ids.map((id) => {
      if (!options.duplicate) return copyProductInStore(ctx, id, transform);
      const sourceName = ctx.read(id)?.attributes[2];
      const name = options.duplicate.name ?? (typeof sourceName === 'string' && sourceName.length > 0 ? `${sourceName} (copy)` : sourceName);
      return copyProductInStore(ctx, id, transform, typeof name === 'string' ? { Name: name } : {});
    }));
  });
}
