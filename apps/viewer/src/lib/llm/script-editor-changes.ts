/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turns a batch of `ScriptEditorTextChange` specs into ONE CodeMirror
 * `ChangeSet` against the live editor document.
 *
 * Two coordinate systems meet here, and conflating them is what produced the
 * production `RangeError`s in #2357 / #2300:
 *
 * - `applyScriptEditOperations` emits its `changes` **sequentially**: every
 *   spec's `from`/`to` index the content *after* the preceding specs in the
 *   same batch have been applied. That is literal — the same numbers are the
 *   arguments to its own running `content.slice()` splice.
 * - CodeMirror's `ChangeSet.of(specs, length)` reads an ARRAY of specs as all
 *   relative to the **original** document. Handing it sequential coordinates
 *   therefore either throws (`Invalid change range <from> to <to> (in doc of
 *   length <n>)`, the crash) or, when the numbers happen to fit, silently
 *   applies the wrong edit.
 *
 * So each spec is composed one at a time against the length its own
 * coordinates belong to, and the composed result is verified to reproduce
 * `nextContent` exactly. A batch that cannot be replayed onto this document
 * (because the document has drifted from the store's copy) is rejected rather
 * than dispatched, so the caller can fall back to a whole-document set and
 * keep the store and the editor holding the same text.
 */

import { ChangeSet, type Text } from '@codemirror/state';
import type { ScriptEditorTextChange } from './types.js';

/** Why a batch could not be replayed onto the live document. */
export type ScriptEditorChangeRejection =
  /** A spec's range falls outside the document it would apply to. */
  | 'out_of_bounds'
  /** The specs applied cleanly but did not reproduce the expected content. */
  | 'content_mismatch';

export type ScriptEditorChangePlan =
  | { ok: true; changes: ChangeSet }
  | {
      ok: false;
      reason: ScriptEditorChangeRejection;
      /** Length of the document the failing spec was measured against. */
      docLength: number;
      /** Length the batch was expected to produce. */
      expectedLength: number;
      rangeFrom: number;
      rangeTo: number;
    };

function isApplicableRange(change: ScriptEditorTextChange, length: number): boolean {
  return (
    Number.isInteger(change.from) &&
    Number.isInteger(change.to) &&
    typeof change.insert === 'string' &&
    change.from >= 0 &&
    change.to >= change.from &&
    change.to <= length
  );
}

/**
 * Compose sequential change specs into a single `ChangeSet` for `doc`.
 *
 * Returns a rejection instead of throwing when the batch does not fit the
 * document — the ranges are validated against the LIVE document (and, for
 * each subsequent spec, against the length the batch has reached), never
 * against the store's possibly-stale copy of the script.
 */
export function planScriptEditorChanges(
  doc: Text,
  changes: readonly ScriptEditorTextChange[],
  nextContent: string,
): ScriptEditorChangePlan {
  let composed = ChangeSet.empty(doc.length);
  for (const change of changes) {
    const length = composed.newLength;
    if (!isApplicableRange(change, length)) {
      return {
        ok: false,
        reason: 'out_of_bounds',
        docLength: length,
        expectedLength: nextContent.length,
        rangeFrom: change.from,
        rangeTo: change.to,
      };
    }
    composed = composed.compose(
      ChangeSet.of({ from: change.from, to: change.to, insert: change.insert }, length),
    );
  }

  if (composed.newLength !== nextContent.length || composed.apply(doc).toString() !== nextContent) {
    return {
      ok: false,
      reason: 'content_mismatch',
      docLength: doc.length,
      expectedLength: nextContent.length,
      rangeFrom: 0,
      rangeTo: composed.newLength,
    };
  }

  return { ok: true, changes: composed };
}
