/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export { mergeDocuments, mergeOps } from './merge.js';
export type { MergeConflict, MergeDiagnostic, MergeOptions, MergeResult, MergeSide } from './types.js';
export { conflictView, resolveConflict, type ConflictCard, type ConflictView } from './view.js';
