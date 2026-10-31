/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared selection, preview and atomic write for paste, array and Duplicate (#6232 D5). */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { copyProductGraph, copyRefusal, createCopyContext, productStoreyOrigin, type CopyContext, type CopyProductResult, type CopyTransform } from './copy-product.js';
import { openTypeRelationBatch, type DuplicateInStoreOptions } from './duplicate.js';
import { copiedProductWork, COPY_PRODUCT_WORK_LIMIT } from './copy-dependent-walk.js';
import { readCopyAttachments, rebindCopiedAttachments, withUnattachedTops, type CopyUnattachedTop } from './copy-attachment.js';

/** Bound pruned root fan-out before allocating products/transforms. */
export const COPY_BATCH_LIMIT = 10_000;

/** Keep roots once; their openings, fillings and assembly parts travel with them. */
export function copySourcesInStore(ctx: CopyContext, ids: readonly number[], copyCount = 1): { ids: number[] } | { refusal: string } {
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
  if (!Number.isSafeInteger(copyCount) || copyCount < 1 || kept.length * copyCount > COPY_BATCH_LIMIT) return { refusal: `A copy batch may contain at most ${COPY_BATCH_LIMIT} root copies` };
  let productWork = 0;
  for (const id of kept) {
    try {
      const refusal = copyRefusal(ctx, id);
      if (refusal) return { refusal };
      productWork += copiedProductWork(ctx, id);
      if (productWork * copyCount > COPY_PRODUCT_WORK_LIMIT) return { refusal: `Copy carried products exceed ${COPY_PRODUCT_WORK_LIMIT} product writes` };
      if (!productStoreyOrigin(ctx, id)) return { refusal: 'The selected element has no placement to copy from' };
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
  /** Deep-copy file shape records with 'own'; default 'shared' keeps current behaviour (#8447). */
  readonly shape?: CopyShape;
  /** Duplicate's naming/randomness policy; displacement is supplied by transforms. */
  readonly duplicate?: Pick<DuplicateInStoreOptions, 'name' | 'guidRandom'>;
}

/**
 * Each transform copies each selected root, in transform-major order. All
 * graph writes succeed together or leave records, journal and allocator intact.
 * A copy on another storey re-resolves its top attachment there
 * (`copy-attachment.ts`).
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
  if (transforms.length > COPY_BATCH_LIMIT) throw new Error(`A copy batch may contain at most ${COPY_BATCH_LIMIT} transforms`);
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
    const sources = copySourcesInStore(ctx, ids, transforms.length);
    if ('refusal' in sources) throw new Error(sources.refusal);
    const attachments = readCopyAttachments(ctx, copiedProductsInStore(ctx, sources.ids));
    const flushTypeRelations = openTypeRelationBatch(draft); // one IfcRelDefinesByType write per type per batch
    const copies = transforms.flatMap((transform) => {
      const results = sources.ids.map((id) => {
        if (!options.duplicate) return copyProductGraph(ctx, id, transform, { shape: options.shape });
        const sourceName = ctx.read(id)?.attributes[2];
        const name = options.duplicate.name ?? (typeof sourceName === 'string' && sourceName.length > 0 ? `${sourceName} (copy)` : sourceName);
        return copyProductGraph(ctx, id, transform, { shape: options.shape, ...(typeof name === 'string' ? { Name: name } : {}) });
      });
      return withUnattachedTops(results, rebindCopiedAttachments(ctx, attachments, results).unattached);
    });
    flushTypeRelations();
    return copies;
  });
}

/** The copy of one selected element (#9352). */
export interface SelectedCopy {
  /** The selected element. */
  readonly sourceId: number;
  /** Its copy: a door or window selected with its wall is its copy in the wall's copy. */
  readonly copyId: number;
  /**
   * Includes notices for this selected element and its carried descendants:
   * the copies of it or of what it carries whose top could not follow their
   * new storey, left fixed with the reason. Absent when there are none.
   */
  readonly unattachedTops?: readonly CopyUnattachedTop[];
}

/**
 * The copy of every selected element, per transform, in selection order
 * (each element once). `copySourcesInStore` copies a door or window selected
 * with its wall, or a part selected with its assembly, through its host's
 * copy: this finds that copy, so a caller gets one copy back for each element
 * it selected. A selected element that no copy carries throws rather than
 * being dropped.
 */
export function copiesOfSelection(ids: readonly number[], results: readonly CopyProductResult[], transformCount: number): SelectedCopy[][] {
  if (!Number.isSafeInteger(transformCount) || transformCount < 1 || results.length % transformCount !== 0) {
    throw new Error(`${results.length} copies cannot be split into ${transformCount} transforms`);
  }
  const per = results.length / transformCount;
  const selection = [...new Set(ids)];
  return Array.from({ length: transformCount }, (_, i) => {
    const group = results.slice(i * per, (i + 1) * per);
    const copyOf = new Map<number, number>();
    const rootOf = new Map<number, CopyProductResult>();
    const noticeOf = new Map<number, CopyUnattachedTop[]>();
    for (const result of group) {
      for (const [copy, source] of result.copiedFrom) if (!copyOf.has(source)) copyOf.set(source, copy);
      const root = result.copiedFrom.get(result.copyId);
      if (root !== undefined) rootOf.set(root, result);
    }
    const selectedIds = new Set(selection.map(id => copyOf.get(id)));
    for (const result of group) for (const notice of result.unattachedTops ?? []) {
      const seen = new Set<number>();
      for (let id: number | undefined = notice.copyId; id !== undefined && !seen.has(id); id = result.carriedBy?.get(id)) {
        seen.add(id);
        if (selectedIds.has(id)) {
          const notices = noticeOf.get(id) ?? [];
          notices.push(notice);
          noticeOf.set(id, notices);
        }
      }
    }
    return selection.map((sourceId) => {
      const copyId = copyOf.get(sourceId);
      if (copyId === undefined) throw new Error(`#${sourceId} was not copied: nothing in the copy carries it`);
      const unattachedTops = rootOf.get(sourceId)?.unattachedTops ?? noticeOf.get(copyId);
      return unattachedTops?.length ? { sourceId, copyId, unattachedTops } : { sourceId, copyId };
    });
  });
}

/** One storey's copies from {@link copyToStoreysInStore}. */
export interface StoreyCopies {
  readonly storeyId: number;
  readonly results: readonly CopyProductResult[];
  /** The copy of each selected element on this storey, in selection order. */
  readonly copies: readonly SelectedCopy[];
  /** Copies on this storey whose top could not follow it, left fixed with the reason (empty when every one followed). */
  readonly unattachedTops: readonly CopyUnattachedTop[];
}

/**
 * Copy a selection onto each of `storeyIds` at the same plan position and
 * height above the floor (Revit's Paste Aligned to Selected Levels, Archicad's
 * copy to storeys): one atomic operation, one Undo step, results per storey.
 */
export function copyToStoreysInStore(
  store: IfcDataStore, editor: StoreEditor, ids: readonly number[], storeyIds: readonly number[],
): readonly StoreyCopies[] {
  if (new Set(storeyIds).size !== storeyIds.length) throw new Error('Each storey can be a copy target only once');
  const results = copyBatchInStore(store, editor, ids, storeyIds.map((targetStoreyId) => ({ targetStoreyId })));
  // Transform-major: each storey's copies are one contiguous run.
  const per = results.length / Math.max(1, storeyIds.length);
  const selected = copiesOfSelection(ids, results, storeyIds.length);
  return storeyIds.map((storeyId, i) => {
    const own = results.slice(i * per, (i + 1) * per);
    return { storeyId, results: own, copies: selected[i], unattachedTops: own.flatMap((result) => result.unattachedTops ?? []) };
  });
}
