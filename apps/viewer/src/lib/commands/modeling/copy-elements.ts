/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one copy write of the Model workspace (#6232 C3): paste and array both
 * land here, inside their command's transaction, so a paste or a whole array
 * is one undo step. Each copy is `copyProductInStore` (`@ifc-lite/create`,
 * D7: fresh GlobalIds, hosted openings, doors and windows copied with their
 * host), written through `recordModellingEdit`, which runs the batch
 * atomically, puts every record on the undo stack and, in a shared room,
 * publishes it.
 */

import { copyProductInStore, copyRefusal, createCopyContext, productStoreyOrigin, type CopyContext, type CopyTransform, type DuplicateInStoreOptions } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from '@/store/slices/mutation-modelling-records';
import { registerAuthoredElement } from '@/utils/spatialHierarchy';

export type { CopyTransform };

export interface CopyOutcome {
  /** The copies of the given elements, in transform-major order. */
  readonly copies: readonly number[];
  /** What to re-mesh: the copies and the doors and windows copied with them. */
  readonly meshed: readonly number[];
  /** Source id for each copied product, for immediate rendering and property lookup. */
  readonly copiedFrom: ReadonlyMap<number, number>;
}

/** A read-only copy context over the model as it is now. */
function readContext(state: ViewerState, modelId: string): CopyContext | null {
  const target = modelEditTarget(state, modelId);
  return target ? createCopyContext(target.dataStore, target.editor) : null;
}

/**
 * The elements a copy of `ids` writes: an opening, door or window whose host
 * is among them rides with its host and is dropped. An element that cannot be
 * copied (an opening or a window alone, a space) refuses the lot, with why.
 */
export function copySources(state: ViewerState, modelId: string, ids: readonly number[]): { ids: number[] } | { refusal: string } {
  const ctx = readContext(state, modelId);
  if (!ctx) return { refusal: `No model loaded for id "${modelId}"` };
  const hostOf = new Map<number, number>();
  for (const [host, openings] of ctx.voids) for (const { id } of openings) hostOf.set(id, host);
  const chosen = new Set(ids);
  // Whatever rides with a chosen element (its opening, door or window, its parts, at any depth) is not copied on its own.
  const carried = (id: number): boolean => {
    const seen = new Set<number>();
    for (let up: number | undefined = id; up !== undefined && !seen.has(up); ) {
      seen.add(up);
      up = ctx.partOf.get(up) ?? hostOf.get(ctx.filledBy.get(up) ?? up);
      if (up !== undefined && chosen.has(up)) return true;
    }
    return false;
  };
  const kept = ids.filter((id) => !carried(id));
  for (const id of kept) {
    const refusal = copyRefusal(ctx, id) ?? placementRefusal(ctx, id);
    if (refusal) return { refusal };
  }
  return kept.length > 0 ? { ids: kept } : { refusal: 'Nothing to copy' };
}

/**
 * Why `id`'s placement cannot be copied (it does not read, or its chain is not
 * tied to its storey), or null. The commit refuses the same elements, so the
 * previews (array, paste) and Ctrl+C turn it into a message up front, never a
 * ghost the commit would then decline and never an exception.
 */
function placementRefusal(ctx: CopyContext, id: number): string | null {
  try {
    return productStoreyOrigin(ctx, id) ? null : `#${id} has no placement to copy from`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** `ids`, the doors and windows in their openings and their assemblies' parts, at any depth: what a preview of their copies shows. */
export function withHostedFillings(state: ViewerState, modelId: string, ids: readonly number[]): number[] {
  const ctx = readContext(state, modelId);
  if (!ctx) return [...ids];
  const shown = new Set<number>();
  const add = (id: number): void => {
    if (shown.has(id)) return;
    shown.add(id);
    for (const { id: opening } of ctx.voids.get(id) ?? []) for (const filling of ctx.fills.get(opening) ?? []) add(filling.id);
    for (const link of ctx.parts.get(id) ?? []) link.parts.forEach(add);
  };
  ids.forEach(add);
  return [...shown];
}

/** Write one copy of every element of `ids` per transform, as one atomic batch. */
export function copyElements(
  store: ModellingStore,
  modelId: string,
  ids: readonly number[],
  transforms: readonly CopyTransform[],
  options: { batchId?: string; duplicate?: DuplicateInStoreOptions } = {},
): CopyOutcome {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) throw new Error(`No model loaded for id "${modelId}"`);
  const results = recordModellingEdit(store, modelId, (_methods, draft) => {
    const ctx = createCopyContext(target.dataStore, draft, { guidRandom: options.duplicate?.guidRandom });
    return transforms.flatMap((transform) => ids.map((id) => {
      if (!options.duplicate) return copyProductInStore(ctx, id, transform);
      const sourceName = ctx.read(id)?.attributes[2];
      const name = options.duplicate.name ?? (typeof sourceName === 'string' && sourceName.length > 0 ? `${sourceName} (copy)` : sourceName);
      return copyProductInStore(ctx, id, transform, typeof name === 'string' ? { Name: name } : {});
    }));
  }, options.batchId);
  // The copies, their doors and windows and their assembly parts join their storey in the spatial tree,
  // as the source's parts are listed under theirs (`effectiveStoreyId` reaches a part through its assembly).
  const hierarchy = target.dataStore.spatialHierarchy;
  for (const result of results) {
    if (!hierarchy || result.storeyId === null) continue;
    for (const id of [result.copyId, ...result.partIds, ...result.fillingIds]) {
      const record = target.view.getNewEntity(id);
      if (!record) continue;
      const name = record.attributes[2];
      registerAuthoredElement(hierarchy, result.storeyId, id, record.type.toUpperCase(), typeof name === 'string' ? name : '');
    }
  }
  const copiedFrom = new Map(results.flatMap((r) => [...r.copiedFrom]));
  for (const [copy, source] of copiedFrom) target.view.setEntityAlias(copy, source);
  return { copies: results.map((r) => r.copyId), meshed: results.flatMap((r) => r.meshed), copiedFrom };
}
