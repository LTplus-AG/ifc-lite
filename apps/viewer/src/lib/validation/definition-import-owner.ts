/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { useViewerStore } from '@/store';
import type { DefinitionKind } from './definition-library.js';

export interface DefinitionImportOwner {
  wanted: () => boolean;
  isLatest: () => boolean;
  committed: () => void;
  finishedReading: () => void;
}
interface Pick { revision: number; reading: boolean }
const picks = new WeakMap<typeof useViewerStore, Map<DefinitionKind, Pick>>();

/** A picked file owns decoding across every mounted caller of the same
 * store and format. Definition changes also cancel its prior context;
 * acknowledging its own synchronous commit keeps its finalizer owned. */
export function beginDefinitionImport(store: typeof useViewerStore, kind: DefinitionKind, reading = false): DefinitionImportOwner {
  let formats = picks.get(store);
  if (!formats) { formats = new Map(); picks.set(store, formats); }
  const owners = formats;
  const pick: Pick = { revision: store.getState().validationDefinitionRevision, reading };
  owners.set(kind, pick);
  const isLatest = () => owners.get(kind) === pick;
  return {
    isLatest,
    wanted: () => isLatest() && pick.revision === store.getState().validationDefinitionRevision,
    committed: () => { if (isLatest()) pick.revision = store.getState().validationDefinitionRevision; },
    finishedReading: () => { pick.reading = false; },
  };
}

/** A source-change effect must not clear a later picked file's busy state. */
export function isDefinitionImportReading(store: typeof useViewerStore, kind: DefinitionKind): boolean {
  const pick = picks.get(store)?.get(kind);
  return Boolean(pick?.reading && pick.revision === store.getState().validationDefinitionRevision);
}
