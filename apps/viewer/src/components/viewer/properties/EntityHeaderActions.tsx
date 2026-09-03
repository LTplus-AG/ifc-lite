/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Header action buttons for the selected entity (Properties panel "info tab"):
 * Zoom to, Hide/Show, and Show in context (ghost).
 *
 * "Show in context" answers #3618: from an Entity List row, a user can select
 * a row and reach this panel, but "Zoom to" alone does not help when the
 * object sits behind other geometry, and full Isolate (the "I" shortcut, via
 * `isolateEntity`) hides everything else and loses spatial context. This
 * button instead reuses the existing X-Ray channel
 * (`ghostExceptEntities`/`setGhostExceptEntities`, already shared by Clash,
 * IDS and BCF) to fade every other entity translucent while framing the
 * camera on the selected one, so the object is visible through the rest of
 * the model instead of disappearing behind it or isolating it away from its
 * surroundings.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Focus, EyeOff, Eye, Ghost } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';

export function EntityHeaderActions() {
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const toggleEntityVisibility = useViewerStore((s) => s.toggleEntityVisibility);
  const isEntityVisible = useViewerStore((s) => s.isEntityVisible);
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const restoreVisibilityState = useViewerStore((s) => s.restoreVisibilityState);

  // The fade outlives this component: PropertiesPanel renders nothing without a
  // selection, so deselecting leaves the whole model translucent with its only
  // control gone (there is no other UI caller of clearGhost and no shortcut).
  //
  // Ownership is recorded when THIS control installs the fade, not derived from
  // the set's contents at cleanup time. Content is not proof of ownership: IDS
  // row focus (useIDS.ts:685-689) and Layer Diff (LayerDiffView.tsx:92-96) both
  // install singleton ghosts and record their own ownership, so a
  // "size === 1 and has(selection)" test at unmount would tear down THEIR
  // presentation. Recording it per render had the mirror-image bug: with the
  // fade on A and the selection moved to B, cleanup compared B against A's set,
  // matched nothing, and left the model faded forever.
  //
  // The claim carries the isolation as it was BEFORE the fade, because entering
  // may widen it to admit the selection (below) and leaving has to give the user
  // back the isolation they had, not the widened one.
  const owned = useRef<{ ghost: ReadonlySet<number>; priorIsolation: Set<number> | null } | null>(null);

  // `explicit` separates the two ways the fade ends. A user clicking a toggle that
  // renders as ON is asking for the channel to clear, whoever installed it, so the
  // click path always clears. Unmount is implicit and silent, so it only touches a
  // fade this control installed -- that is the case where clearing someone else's
  // presentation would be invisible and wrong.
  const releaseGhost = useCallback((explicit: boolean) => {
    const claim = owned.current;
    const s = useViewerStore.getState();
    // Identity, not contents: anything that replaced the channel since is theirs,
    // and its prior isolation is not ours to restore.
    const ours = claim !== null && s.ghostExceptEntities === claim.ghost;
    owned.current = null;
    if (ours) {
      // Give back the isolation as it was BEFORE the fade widened it.
      s.restoreVisibilityState({
        isolated: claim.priorIsolation,
        ghostExcept: null,
        hidden: s.hiddenEntities,
      });
    } else if (explicit && s.ghostExceptEntities !== null) {
      // Not ours, but the user asked. clearGhost preserves isolation, and we have
      // no prior isolation to restore because we never widened one.
      s.clearGhost();
    }
  }, []);

  useEffect(() => () => releaseGhost(false), [releaseGhost]);

  const isGhosted = selectedEntityId != null &&
    ghostExceptEntities !== null &&
    ghostExceptEntities.size === 1 &&
    ghostExceptEntities.has(selectedEntityId);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700"
            onClick={() => {
              if (selectedEntityId && cameraCallbacks.frameSelection) {
                cameraCallbacks.frameSelection();
              }
            }}
          >
            <Focus className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Zoom to</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={`rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700 ${isGhosted ? 'text-primary' : ''}`}
            onClick={() => {
              if (!selectedEntityId) return;
              if (isGhosted) {
                // clearGhost, not setGhostExceptEntities(null): it preserves
                // isolation, which the setter clears.
                releaseGhost(true);
              } else {
                // Not setGhostExceptEntities: that clears isolatedEntities
                // unconditionally and nothing captured it, so isolating a zone
                // and then fading around a member destroyed the isolation for
                // good. Writing both channels keeps it. The pair is coherent --
                // isolation filters, ghosting fades what survived it -- and
                // restoreVisibilityState documents it as reachable and legal.
                // An isolation that does not contain the selection would hide
                // the very entity being shown: isEntityVisible rejects every id
                // absent from isolatedEntities, and ghosting only fades what
                // survived that filter, so the camera would frame something
                // invisible. Admit the selection rather than drop the isolation.
                const isolated = isolatedEntities === null
                  ? null
                  : isolatedEntities.has(selectedEntityId)
                    ? isolatedEntities
                    : new Set([...isolatedEntities, selectedEntityId]);
                restoreVisibilityState({
                  isolated,
                  ghostExcept: new Set([selectedEntityId]),
                  hidden: hiddenEntities,
                });
                // Read the ghost identity BACK: restoreVisibilityState copies the
                // set it is given, so the object handed in is not the one
                // installed. Keep the ORIGINAL isolation, not the widened one.
                const installed = useViewerStore.getState().ghostExceptEntities;
                if (installed) owned.current = { ghost: installed, priorIsolation: isolatedEntities };
                cameraCallbacks.frameSelection?.();
              }
            }}
          >
            <Ghost className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {isGhosted ? 'Clear "show in context"' : 'Show in context (fade the rest, keep it visible)'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700"
            onClick={() => {
              if (selectedEntityId) {
                toggleEntityVisibility(selectedEntityId);
              }
            }}
          >
            {selectedEntityId && isEntityVisible(selectedEntityId) ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {selectedEntityId && isEntityVisible(selectedEntityId) ? 'Hide' : 'Show'}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
