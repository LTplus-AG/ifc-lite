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
  // Read at open only. `existingSpaceIds` is memoised on `ifcDataStore`, so its
  // identity changes whenever the store does — including mid-session, after the
  // tool's own edits. Depending on it would re-run the whole open behaviour: the
  // cleanup would `restore` the pre-tool view (dropping the X-ray and re-hiding
  // spaces), then re-capture that restored state as "prior" and move the camera
  // again, in the middle of drafting. `sceneEnabled` already requires a store, so
  // the value latched here is the correct one.
  const existingSpaceIdsRef = useRef(existingSpaceIds);
  existingSpaceIdsRef.current = existingSpaceIds;

  // Tear down the open behavior: put isolation / X-ray / spaces visibility
  // back to what they were before the tool opened. `keepSpacesVisible` keeps
  // IfcSpace shown (after a confirm, so the user sees what they created).
  const restore = useCallback((opts: { keepSpacesVisible: boolean }) => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const prior = priorRef.current;
    if (!prior) return;
    const store = useViewerStore.getState();
    // Isolation, X-ray and per-entity hiding all clear each other through the
    // individual setters (isolation and ghosting are mutually exclusive;
    // isolation supersedes hiding). Replaying them one call at a time therefore
    // walked through states the user never had — and one of those intermediate
    // states nulls the very channel the next call restores, which strips the
    // ownership record off a presentation that is coming straight back (#2662
    // P2, re-found in the review of #2867). One atomic restore instead: the
    // captured view is a single fact and goes back as one.
    //
    // Two behaviour changes come with it, both wanted: a captured ISOLATION now
    // survives a non-empty captured hidden set (the replay's `setHiddenEntities`
    // nulled the isolation it had just restored), and a Class-tab `classFilter`
    // this tool never touched is no longer cleared on close (that same setter
    // nulls it).
    store.restoreVisibilityState(prior);
    // Restore against the CAPTURED visibility, not a "did we flip it" flag —
    // something else may have toggled spaces mid-session. `keepSpacesVisible`
    // is a floor on that target rather than a skip: after a confirm the user
    // must SEE the spaces they just created, and reading it as "leave whatever
    // is there" closed the tool with them hidden whenever anything turned
    // spaces off mid-session (the visibility panel is one click away, and the
    // tool is open the whole time).
    const targetSpacesVisible = opts.keepSpacesVisible || prior.spacesVisible;
    if (store.typeVisibility.spaces !== targetSpacesVisible) {
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
    const ids = existingSpaceIdsRef.current;
    if (ids.length > 0) {
      store.cameraCallbacks.frameEntities?.(ids);
    } else {
      store.cameraCallbacks.frameBuildingExtent?.();
    }

    return () => {
      // Safety net for any unmount the explicit close paths didn't handle
      // (tool switched away, etc.): put the prior view back.
      restore({ keepSpacesVisible: false });
    };
    // Deliberately NOT `existingSpaceIds`: this is the ONE-SHOT open behaviour,
    // keyed on the open transition alone (see the ref above).
  }, [enabled, restore]);

  return { restore };
}
