/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { useViewerStore } from '@/store';
import type { DefinitionKind } from './definition-library.js';

export interface DefinitionImportOwner {
  wanted: () => boolean;
  isLatest: () => boolean;
  committed: () => void;
}
interface Pick { revision: number }
const picks = new WeakMap<typeof useViewerStore, Map<DefinitionKind, Pick>>();

/** A picked file owns decoding across every mounted caller of the same
 * store and format. Definition changes also cancel its prior context;
 * acknowledging its own synchronous commit keeps its finalizer owned. */
export function beginDefinitionImport(store: typeof useViewerStore, kind: DefinitionKind): DefinitionImportOwner {
  let formats = picks.get(store);
  if (!formats) { formats = new Map(); picks.set(store, formats); }
  const owners = formats;
  const pick: Pick = { revision: store.getState().validationDefinitionRevision };
  owners.set(kind, pick);
  const isLatest = () => owners.get(kind) === pick;
  return {
    isLatest,
    wanted: () => isLatest() && pick.revision === store.getState().validationDefinitionRevision,
    committed: () => { if (isLatest()) pick.revision = store.getState().validationDefinitionRevision; },
  };
}
