/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A copy on another storey re-resolves its top attachment (#9296). The copy
 * carries its source's `IfcLite_StoreyAttachment` verbatim (metadata is
 * cloned with it); this rewrites it for the copy's storey:
 *
 * - relative ("home storey + 1"): the copy attaches to the storey above its
 *   new storey and keeps its source's offset from the floor it reaches, so
 *   its height follows the new floor-to-floor; with no storey above it is
 *   recorded `NextStoreyAbove`, which the next storey added above binds;
 * - explicit ("Up to level: X"): the copy stays attached to X, its height
 *   refit so its top still reaches X; a copy whose base lands at or above X
 *   is refused;
 * - a slab: the copy reaches the copy of that slab when the slab was copied
 *   in the same operation, else the slab itself, refit to its underside.
 *
 * A copy that needs a new height but still shares its source's shape (a
 * shape read from the file is shared by reference, `copy-product.ts`) cannot
 * be resized without resizing the source. It is recorded fixed at the
 * source's height instead, never left attached at the wrong height, and
 * listed in the result's `unattachedTops` with the reason. (Deep-copying
 * file shapes is #8447.) A level beam or member is not affected: it follows
 * by moving its own placement. A copy whose body cannot be read is listed
 * the same way, unless its re-bound record needs no new height.
 *
 * Elements with no record are fixed and are copied as they are.
 */

import { readStoreyInventory, storeyNeighbour, type StoreyInventory } from './storey/storey-model.js';
import {
  clearTopAttachment, homeStoreyOf, readTopAttachment, writeTopAttachment, NEXT_STOREY_ABOVE, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT, type TopAttachment,
} from './storey/storey-attachment.js';
import {
  attachedKind, attachedTopEditsBody, attachedTopWorldOrigin, readAttachedTop, writeAttachedTop, MIN_ATTACHED_EXTENT,
} from './storey/storey-attached.js';
import { slabUndersideWorld } from './storey/storey-attachment-target.js';
import { scaleWallQuantities, wallGeometry } from './storey/storey-level-write.js';
import { placementInAncestor, refId } from './host-geometry-frame.js';
import type { CopyContext, CopyProductResult } from './copy-product.js';

/** What the copies of one batch read from the model as it stood before the batch. */
export interface CopyAttachmentContext {
  /** Null when nothing the batch copies records a top attachment (most pastes and arrays). */
  readonly inventory: StoreyInventory | null;
  /** Source id → its attachment and home storey, for sources that record one. */
  readonly sources: ReadonlyMap<number, { attachment: TopAttachment; homeId: number }>;
}

/** Read the attachments of every product a batch may copy (roots and what they carry). */
export function readCopyAttachments(ctx: CopyContext, ids: Iterable<number>): CopyAttachmentContext {
  const view = ctx.editor.getMutationView();
  // The storey inventory reads the whole model: only read it when a copy records an attachment.
  const recorded = [...ids].filter((id) => attachedKind(ctx.read(id)?.type)
    && (view.getPropertyValue(id, STOREY_ATTACHMENT_PSET, TOP_CONSTRAINT) !== null || view.getPropertyValue(id, 'Constraints', 'Top Constraint') !== null));
  const sources = new Map<number, { attachment: TopAttachment; homeId: number }>();
  if (recorded.length === 0) return { inventory: null, sources };
  const inventory = readStoreyInventory(ctx.store, view);
  for (const id of recorded) {
    const attachment = readTopAttachment(inventory, id);
    const homeId = homeStoreyOf(inventory, id);
    if (attachment && homeId !== null) sources.set(id, { attachment, homeId });
  }
  return { inventory, sources };
}

/** A copy left fixed at its source's height because its top could not follow its new storey. */
export interface CopyUnattachedTop {
  readonly copyId: number;
  readonly reason: string;
}

const UNREADABLE_BODY = 'its body cannot be read, so its top cannot follow; it keeps its height and is no longer attached';
const SHARED_BODY = "it shares the source's shape from the file, which a copy cannot resize; it keeps the source's height and is no longer attached";

const fail = (copyId: number, reason: string) => new Error(`The copy #${copyId} cannot keep its top attachment on its new storey: ${reason}`);

/**
 * Re-resolve the attachments of one transform's copies (all of them, so a
 * slab copied alongside is found). Throws, inside the batch's atomic
 * transaction, when a copy cannot take its new height.
 */
export function rebindCopiedAttachments(
  ctx: CopyContext, attachments: CopyAttachmentContext, results: readonly CopyProductResult[],
): { reshaped: number[]; unattached: CopyUnattachedTop[] } {
  const { inventory } = attachments;
  const unattached: CopyUnattachedTop[] = [];
  if (!inventory || attachments.sources.size === 0) return { reshaped: [], unattached };
  const copyOf = new Map<number, number>();
  for (const result of results) for (const [copy, source] of result.copiedFrom) copyOf.set(source, copy);
  const view = ctx.editor.getMutationView();
  const target = { dataStore: ctx.store, view, editor: ctx.editor };
  const reshaped: number[] = [];
  for (const result of results) {
    const storeyId = result.storeyId;
    if (storeyId === null) continue;
    for (const [copyId, sourceId] of result.copiedFrom) {
      const source = attachments.sources.get(sourceId);
      const kind = attachedKind(ctx.read(copyId)?.type);
      if (!source || !kind) continue;
      const { attachment, homeId } = source;
      // Only a copy whose target changes needs a new record: a slab copied with it, or another storey.
      const slabCopy = attachment.targetElementId === undefined ? undefined : copyOf.get(attachment.targetElementId);
      if (storeyId === homeId && slabCopy === undefined) continue;
      const home = inventory.storeys.find((storey) => storey.expressId === homeId)!;
      const here = inventory.storeys.find((storey) => storey.expressId === storeyId);
      if (!here) continue;
      const next = storeyNeighbour(inventory, storeyId, 1);
      // The record first; a copy whose body cannot be read keeps it only where it needs no refit (below).
      if (attachment.kind === 'element') {
        if (slabCopy !== undefined) writeTopAttachment(view, copyId, String(ctx.read(slabCopy)?.attributes[0]), 'explicit');
      } else if (attachment.binding === 'relative') {
        writeTopAttachment(view, copyId, next ? next.GlobalId : NEXT_STOREY_ABOVE, 'relative');
      } else {
        const reached = inventory.storeys.find((storey) => storey.expressId === attachment.targetStoreyId)!;
        if (here.elevation >= reached.elevation) throw fail(copyId, `it is attached to ${reached.Name}, which is not above its new storey ${here.Name}`);
      }
      const from = readAttachedTop(target, copyId, kind);
      if (from === null) {
        // Only a relative top with the same spacing above (or no storey above yet) is right without a refit.
        const reached = attachment.targetStoreyId === null ? null : inventory.storeys.find((storey) => storey.expressId === attachment.targetStoreyId);
        const sameGap = attachment.kind === 'storey' && attachment.binding === 'relative'
          && (!next || (reached !== null && reached !== undefined && Math.abs((next.elevation - here.elevation) - (reached.elevation - home.elevation)) < 1e-9));
        if (!sameGap) {
          clearTopAttachment(view, copyId);
          unattached.push({ copyId, reason: UNREADABLE_BODY });
        }
        continue;
      }
      let to = from;
      if (attachment.kind === 'element') {
        const slabId = slabCopy ?? attachment.targetElementId!;
        const underside = slabUndersideWorld(target, slabId);
        const origin = attachedTopWorldOrigin(target, copyId, kind);
        if (underside === null || origin === null || !Number.isFinite(origin)) throw fail(copyId, `the slab #${slabId} or the copy cannot be read`);
        to = underside - origin;
      } else if (attachment.binding === 'explicit') {
        // The top stays on the storey it names; the base moved with the copy.
        to = from - (here.elevation - home.elevation);
      } else if (!next) {
        continue;
      } else if (attachment.targetStoreyId !== null) {
        const reached = inventory.storeys.find((storey) => storey.expressId === attachment.targetStoreyId)!;
        // The same offset from the floor above: the height follows the new floor-to-floor.
        to = from + (next.elevation - here.elevation) - (reached.elevation - home.elevation);
      } else {
        // Drawn unbound: the copy reaches the storey above its new one.
        const origin = attachedTopWorldOrigin(target, copyId, kind);
        const floor = here.placementId === null ? null : placementInAncestor(inventory.reader, here.placementId, null);
        if (origin === null || !Number.isFinite(origin)) continue;
        to = from + (next.elevation - here.elevation) - (origin + from - (floor ? floor.o[2] * inventory.scale : here.elevation));
      }
      if (Math.abs(to - from) < 1e-9) continue;
      if (kind !== 'linear' && to < MIN_ATTACHED_EXTENT) throw fail(copyId, `it would end ${to.toFixed(3)} m tall`);
      const shape = refId(ctx.read(copyId)?.attributes[6]);
      // A level beam is lifted by its own placement, so a shared body does not stop it.
      if (shape !== null && shape === refId(ctx.read(sourceId)?.attributes[6]) && attachedTopEditsBody(target, copyId, kind)) {
        clearTopAttachment(view, copyId);
        unattached.push({ copyId, reason: SHARED_BODY });
        continue;
      }
      const geometry = kind === 'wall' ? wallGeometry(ctx.store, view, ctx.editor, copyId) : undefined;
      const outcome = writeAttachedTop(target, copyId, kind, from, to);
      if (!outcome.ok) throw fail(copyId, outcome.reason);
      if (kind === 'wall') scaleWallQuantities(ctx.store, view, copyId, to / from, geometry);
      reshaped.push(...outcome.remesh);
    }
  }
  return { reshaped, unattached };
}

/** `results` with each copy's `unattachedTops` filled in from one re-bind. */
export function withUnattachedTops(results: readonly CopyProductResult[], unattached: readonly CopyUnattachedTop[]): CopyProductResult[] {
  if (unattached.length === 0) return [...results];
  return results.map((result) => {
    const own = unattached.filter(({ copyId }) => result.copiedFrom.has(copyId));
    return own.length ? { ...result, unattachedTops: own } : result;
  });
}
