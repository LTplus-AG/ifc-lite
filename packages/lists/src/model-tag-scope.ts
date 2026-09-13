/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which models a list runs over, by the viewer's user-facing MODEL TAGS
 * (issue #4215). Persisted on `ListDefinition.modelTagScope`.
 *
 * `tagIds` are the viewer's stable tag ids — a rename changes nothing here —
 * and the four operators read exactly as they do in the viewer's search and
 * clash rules: `hasAny` (at least one of), `hasAll` (every one of), `hasNone`
 * (none of), `untagged` (the model carries no tag at all; `tagIds` is
 * ignored). Independent of `expressIdsByModel` and `entityTypes`, which scope
 * ELEMENTS within whichever models are in scope. Absent means every model,
 * so a list persisted before this existed runs as it did.
 *
 * The package only carries the shape; resolving it against a federation's
 * tags is the viewer's (`apps/viewer/src/lib/lists/model-tag-scope.ts`), and
 * a scope naming a tag that no longer exists must be refused there, never
 * widened.
 */
export interface ListModelTagScope {
  op: 'hasAny' | 'hasAll' | 'hasNone' | 'untagged';
  tagIds: string[];
}
