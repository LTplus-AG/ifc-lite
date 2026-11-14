/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which IfcLite markup annotations EMBEDDED in a model's file this session
 * actually absorbed into `Drawing2DState`, so "save markup to model" may
 * replace those and nothing else.
 *
 * The save sweeps embedded markup before writing (`drawing-markup-embedded-
 * sweep.ts`) so a reopened file does not gain a second copy. That is only safe
 * for annotations whose content is in the session: the embedded restore can
 * give up (the user drew before the symbolic parse landed, or a localStorage
 * entry for the file won precedence), and sweeping markup the user never saw
 * deletes it. So:
 *
 * - the embedded restore records the identity of every annotation it read
 *   into the session (`useDrawingMarkupRestoreOnLoad.ts`);
 * - the localStorage entry carries the set (`absorbedEmbeddedMarkup`), written
 *   by `drawingMarkupSave.ts`'s `persistFor`, and a localStorage restore adds
 *   it back (`useDrawing2DPersistence.ts`). That entry is keyed by the file's
 *   full-content hash, so its set names annotations of these exact bytes, and
 *   reopening a file whose entry was seeded from its own embedded markup still
 *   replaces that markup instead of duplicating it;
 * - the save removes only embedded annotations in the set; everything else
 *   embedded is kept and the new markup is written beside it.
 *
 * An identity is the annotation's GlobalId, or `#<expressId>` when it has none
 * ({@link embeddedMarkupIdentity}). The set is scoped to the model id AND its
 * source (the `File`, or the parsed store for a model without one), so a
 * different file reopened under the same model id starts from nothing.
 */

import { useViewerStore } from '@/store';

/** Derives identities once the model is readable; `null` while it is not (see {@link absorbEmbeddedMarkupOnceReadable}). */
type Derive = () => string[] | null;

const absorbed = new Map<string, { source: WeakRef<object> | null; ids: Set<string>; pending?: Derive[] }>();

function sourceOf(modelId: string): object | null {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  return model?.sourceFile ?? model?.ifcDataStore ?? (modelId === 'legacy' ? state.ifcDataStore : null) ?? null;
}

/** The annotation's GlobalId, or `#<expressId>` when it carries none. */
export function embeddedMarkupIdentity(expressId: number, globalId: unknown): string {
  return typeof globalId === 'string' && globalId.length > 0 ? globalId : `#${expressId}`;
}

/** Record `ids` as absorbed into the session for `modelId`'s current source. */
export function absorbEmbeddedMarkup(modelId: string, ids: Iterable<string>): void {
  const source = sourceOf(modelId);
  if (!source) return;
  let entry = absorbed.get(modelId);
  if (!entry || entry.source?.deref() !== source) {
    entry = { source: new WeakRef(source), ids: new Set() };
    absorbed.set(modelId, entry);
  }
  for (const id of ids) entry.ids.add(id);
}

/** The embedded annotations the session absorbed for `modelId`'s current source; empty when none. */
export function absorbedEmbeddedMarkupFor(modelId: string): ReadonlySet<string> {
  return settledEntryFor(modelId)?.ids ?? new Set();
}

/** The entry for `modelId`'s current source, every derivation that can run now applied; `null` when none. */
function settledEntryFor(modelId: string) {
  const entry = absorbed.get(modelId);
  const source = sourceOf(modelId);
  if (!entry || !source || entry.source?.deref() !== source) return null;
  entry.pending = entry.pending?.filter((derive) => {
    const ids = derive();
    for (const id of ids ?? []) entry.ids.add(id);
    return ids === null;
  });
  return entry;
}

/**
 * Record what `derive` returns as absorbed, now or, while it returns `null`
 * (the model's store is not readable yet: a restore can run while the file is
 * still loading), the next time the set is read. Until then the set is
 * undecided ({@link isAbsorbedEmbeddedMarkupDecided}), so a save to
 * localStorage leaves the entry's field absent instead of recording an empty
 * set that would stop a later restore from deriving it.
 */
export function absorbEmbeddedMarkupOnceReadable(modelId: string, derive: Derive): void {
  absorbEmbeddedMarkup(modelId, []);
  const entry = absorbed.get(modelId);
  if (!entry || entry.source?.deref() !== sourceOf(modelId)) return;
  entry.pending = [...entry.pending ?? [], derive];
  settledEntryFor(modelId);
}

/** Whether every derivation for `modelId`'s current source has run. */
export function isAbsorbedEmbeddedMarkupDecided(modelId: string): boolean {
  return (settledEntryFor(modelId)?.pending?.length ?? 0) === 0;
}

/**
 * Forget what `modelId` absorbed. Called when the model becomes active and its
 * markup fields are cleared: from then on the session holds only what a
 * restore puts back, and each restore re-adds its own set (the localStorage
 * entry's, or the embedded restore's). Keeping the old set would let a save
 * replace embedded markup that is no longer on screen, e.g. a model without
 * a `File` (nothing is persisted for it) after the user left and returned.
 */
export function forgetAbsorbedEmbeddedMarkup(modelId: string): void {
  absorbed.delete(modelId);
}

/** @internal test-only reset. */
export function __resetAbsorbedEmbeddedMarkupForTests(): void {
  absorbed.clear();
}
