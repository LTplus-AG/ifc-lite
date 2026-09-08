/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The user-facing notices a committed wall split emits.
 *
 * `MutationSlice.splitWallAtDistance` is reached from TWO places — the canvas
 * click handler (`selectionHandlers.ts`) and the Split tool's numeric-distance
 * panel (`tools/SplitNumericInput.tsx`) — and both must report the same split
 * the same way. They previously each inlined their own copy of the
 * "(N openings reassigned)" wording, and #3023 taught only the click handler to
 * also surface `openings.skipped`, so committing the identical split by typing
 * a distance instead of clicking silently dropped that warning.
 *
 * This module is the single definition of both notices. Call
 * {@link notifyWallSplit} rather than composing the toasts at a call site: a
 * shared formatter is still one a new call site can forget to call, which is
 * precisely how the two paths came apart. A shared EMITTER cannot be half-used.
 *
 * It deliberately imports nothing but the toast surface, so a call site does
 * not take on `selectionHandlers.ts`'s store, geometry and measurement imports
 * just to announce a split.
 */

import { toast } from '@/components/ui/toast';

/**
 * `OpeningReassignSummary` as far as the notices care: how many of the source
 * wall's openings moved to each half, and how many were left on neither.
 *
 * Produced by `reassignWallOpenings` (`@/lib/wall-opening-reassign.ts`) and
 * forwarded verbatim by `splitWallAtDistance`
 * (`store/slices/mutationSlice.ts:1981`), which also substitutes an all-zero
 * summary when either half's placement chain does not resolve and the
 * reassignment is therefore never attempted.
 */
export interface OpeningReassignCounts {
  toLeft: number;
  toRight: number;
  skipped: number;
}

/**
 * The "(N openings reassigned)" suffix for the wall-split success toast.
 * Pure so the wording is unit-testable without driving the full split flow
 * through the store. Deliberately silent when nothing moved: "0 openings
 * moved" is noise for a wall with no doors or windows.
 */
export function formatOpeningReassignSuffix(op: OpeningReassignCounts): string {
  const moved = op.toLeft + op.toRight;
  return moved > 0 ? ` (${moved} opening${moved === 1 ? '' : 's'} reassigned)` : '';
}

/**
 * Announce a wall split that has already been committed.
 *
 * Always emits the success toast. Additionally warns when
 * `openings.skipped > 0`: those openings stay attached to the source wall the
 * split has just tombstoned rather than moving to either half, so they can end
 * up orphaned.
 *
 * `skipped` is incremented at twelve distinct sites in
 * `@/lib/wall-opening-reassign.ts` (lines 123-203), only one of which is an
 * unresolvable placement chain. The rest are an attribute the reader could not
 * read or a reference the opening does not carry — and one is not a fault at
 * all: an opening whose `PlacementRelTo` points somewhere other than the source
 * wall is skipped on purpose, because rewriting its parent placement would
 * teleport it. Zero is the ordinary outcome, which is why this stays quiet
 * then; it must not be quiet on ONE of the two commit paths when it is not.
 */
export function notifyWallSplit(op: OpeningReassignCounts): void {
  toast.success(`Wall split${formatOpeningReassignSuffix(op)} — Ctrl+Z to undo`);
  if (op.skipped > 0) {
    toast.info(
      `${op.skipped} opening${op.skipped === 1 ? '' : 's'} could not be reassigned and may need manual repositioning`,
    );
  }
}
