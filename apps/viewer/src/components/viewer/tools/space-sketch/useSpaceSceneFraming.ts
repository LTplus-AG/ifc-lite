/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D scene framing + view capture/restore for the Space Sketch tool.
 *
 * On open the tool makes the spaces the user is about to sketch visible
 * without taking the building away (IfcSpace is class-hidden by default and
 * the shell obscures it):
 *   - turn IfcSpace visibility on,
 *   - frame the existing spaces' extent when the model has any, otherwise
 *     frame the building shell (NOT the much larger site extent).
 * The building itself is never hidden — while drafts exist the ghost-preview
 * hook X-rays it via `ghostExceptEntities` so the rooms read in context.
 *
 * On close `restore` replays the exact prior view (isolation, X-ray, spaces
 * visibility), EXCEPT after a confirm (`keepSpacesVisible`) where the
 * freshly-created spaces should stay visible. `restore` is idempotent so the
 * explicit close paths and the unmount cleanup can both call it safely.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';

interface SceneFramingArgs {
  /** Tool open AND a model present. Drives the one-shot open behavior. */
  enabled: boolean;
  /** The model's existing IfcSpace ids (federated GLOBAL ids). */
  existingSpaceIds: number[];
}

export function useSpaceSceneFraming({ enabled, existingSpaceIds }: SceneFramingArgs): {
  restore: (opts: { keepSpacesVisible: boolean }) => void;
} {
  // Prior 3D view state captured on open, replayed on close.
  const priorRef = useRef<{
    isolated: Set<number> | null;
    ghostExcept: Set<number> | null;
    hidden: Set<number>;
    spacesVisible: boolean;
  } | null>(null);
  const restoredRef = useRef(false);

  // Tear down the open behavior: put isolation / X-ray / spaces visibility
  // back to what they were before the tool opened. `keepSpacesVisible` keeps
  // IfcSpace shown (after a confirm, so the user sees what they created).
  const restore = useCallback((opts: { keepSpacesVisible: boolean }) => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const prior = priorRef.current;
    if (!prior) return;
    const store = useViewerStore.getState();
    // Isolation and X-ray are mutually exclusive in the slice (each setter
    // clears the other), so restore isolation first, then any prior X-ray.
    store.setIsolatedEntities(prior.isolated);
    // `setIsolatedEntities` also clears `hiddenEntities` (visibilitySlice.ts:220
    // — isolation supersedes per-entity hiding). This tool never owned that set,
    // so put it back verbatim: otherwise simply opening and closing Space Sketch
    // un-hides everything the user had hidden beforehand.
    if (prior.hidden.size > 0) store.setHiddenEntities(prior.hidden);
    if (prior.ghostExcept) store.setGhostExceptEntities(prior.ghostExcept);
    // Restore against the CAPTURED visibility, not a "did we flip it" flag —
    // something else may have toggled spaces mid-session.
    if (!opts.keepSpacesVisible && store.typeVisibility.spaces !== prior.spacesVisible) {
      store.toggleTypeVisibility('spaces');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const store = useViewerStore.getState();
    restoredRef.current = false;
    priorRef.current = {
      isolated: store.isolatedEntities ? new Set(store.isolatedEntities) : null,
      ghostExcept: store.ghostExceptEntities ? new Set(store.ghostExceptEntities) : null,
      hidden: new Set(store.hiddenEntities),
      spacesVisible: store.typeVisibility.spaces,
    };

    // Reveal spaces so the existing rooms and the draft ghosts are not
    // class-hidden while the tool is open.
    if (!store.typeVisibility.spaces) store.toggleTypeVisibility('spaces');

    // One gentle camera move per open: to the existing spaces when there are
    // any, else to the building shell (not the georeferenced site extent).
    if (existingSpaceIds.length > 0) {
      store.cameraCallbacks.frameEntities?.(existingSpaceIds);
    } else {
      store.cameraCallbacks.frameBuildingExtent?.();
    }

    return () => {
      // Safety net for any unmount the explicit close paths didn't handle
      // (tool switched away, etc.): put the prior view back.
      restore({ keepSpacesVisible: false });
    };
  }, [enabled, existingSpaceIds, restore]);

  return { restore };
}
