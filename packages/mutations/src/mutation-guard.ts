/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Optional local-edit guard for the "always-local" write engines
 * (`BulkQueryEngine`, `CsvConnector`).
 *
 * These two classes are constructed directly by viewer components
 * (`BulkPropertyEditor.tsx`, `DataConnector.tsx`) and write straight to a
 * `MutablePropertyView`, bypassing the Zustand store's `setProperty` /
 * `setEntityType` actions — and, with them, `canCollabEdit()`. Unlike
 * `MutablePropertyView` and `StoreEditor` themselves (see the module doc on
 * `MutablePropertyView`), neither engine is ever reached by inbound CRDT
 * replay, `useZoneWriteBack`, or any `mirror*` helper: both are always
 * constructed fresh, per dialog-open, from a local user action, and never
 * shared with — or passed into — the collab plumbing. That makes them safe
 * to gate at construction: there is no legitimate caller this guard could
 * wrongly block.
 *
 * A caller passes a `canEdit` predicate at construction; the engine consults
 * it once before mutating and throws `MutationGuardError` (rather than
 * silently dropping the write) if it returns false. Passing no predicate
 * preserves today's behaviour exactly — this is opt-in, not a new default,
 * so it does not change any other consumer of these classes (CLI, SDK,
 * sandbox bridge, existing tests).
 */

/** Thrown by a guarded engine when `canEdit()` returns false. */
export class MutationGuardError extends Error {
  constructor(message = 'Mutation blocked: editing is disabled for the current role') {
    super(message);
    this.name = 'MutationGuardError';
  }
}

/** Predicate consulted before a guarded engine applies a write. */
export type MutationGuard = () => boolean;

/** Throws `MutationGuardError` if `guard` is present and returns false. */
export function checkMutationGuard(guard: MutationGuard | undefined | null): void {
  if (guard && !guard()) {
    throw new MutationGuardError();
  }
}
