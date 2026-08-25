/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply the entity-scoped embed URL parameters (`?select=`, `?isolate=`) once
 * the first model is on screen.
 *
 * `urlParams.ts` has parsed these since the embed shipped and nothing ever
 * read them (#2934): the parser is thoroughly tested, the application of the
 * parsed value did not exist. `?hideTypes=` and `?camera=` are applied at
 * their own actuators in `EmbedViewer.tsx` (the geometry filter and the
 * camera-callback poll respectively) rather than here.
 *
 * Two things this hook is deliberate about:
 *
 *  - It waits for geometry. Both parameters name entity ids in a model that is
 *    still being fetched at mount, and `loadFile` resets selection as part of
 *    ingesting a model — applying them earlier writes state that the load then
 *    throws away.
 *  - It applies them exactly ONCE, guarded by a ref rather than by the
 *    dependency array. `isolateEntities` (visibilitySlice) is a same-set
 *    TOGGLE — a second call with identical ids CLEARS isolation — so an effect
 *    that re-ran would undo itself. `setIsolatedEntities` is used instead of
 *    `isolateEntities` for the same reason: it assigns, so it cannot toggle.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { EmbedViewerUrlParams } from '../bridge/urlParams.js';

/**
 * Normalise `?hideTypes=` names into a lookup set.
 *
 * Case-folded on purpose. `mesh.ifcType` is PascalCase (`IfcSpace`), while the
 * embed SDK's own documented example passes SCREAMING_CASE (`IFCSPACE`, the
 * spelling STEP files use). A raw string comparison would match neither the
 * SDK's example nor a host page typing `ifcspace`, and would hide nothing
 * while reporting no error. Returns `null` when there is nothing to hide, so
 * the caller can skip the filter entirely.
 */
export function toHiddenTypeSet(names: string[] | undefined): Set<string> | null {
  if (!names || names.length === 0) return null;
  const set = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0) set.add(trimmed.toLowerCase());
  }
  return set.size > 0 ? set : null;
}

/** True when `ifcType` is named by a `toHiddenTypeSet` result. */
export function isTypeHidden(ifcType: string | undefined, hidden: Set<string> | null): boolean {
  if (!hidden || !ifcType) return false;
  return hidden.has(ifcType.toLowerCase());
}

export function useEmbedUrlParams(urlParams: EmbedViewerUrlParams, modelReady: boolean): void {
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current || !modelReady) return;
    if (!urlParams.select && !urlParams.isolate) return;
    applied.current = true;

    const state = useViewerStore.getState();
    if (urlParams.select) state.setSelectedEntityIds(urlParams.select);
    if (urlParams.isolate) state.setIsolatedEntities(new Set(urlParams.isolate));
  }, [modelReady, urlParams.select, urlParams.isolate]);
}
