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

import { useEffect, useRef } from 'react';
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
  const clearGhost = useViewerStore((s) => s.clearGhost);

  // The fade outlives this component: PropertiesPanel renders nothing without a
  // selection, so deselecting leaves the whole model translucent with its only
  // control gone (there is no other UI caller of clearGhost and no shortcut).
  // Tear down on unmount, but only OUR fade -- a singleton set holding exactly
  // the entity we were showing. A clash or IDS ghost holds many entities and
  // owns its own teardown, so it is left standing.
  const ghostRef = useRef<{ id: number | null; set: ReadonlySet<number> | null }>({ id: null, set: null });
  ghostRef.current = { id: selectedEntityId ?? null, set: ghostExceptEntities };
  useEffect(() => () => {
    const { id, set } = ghostRef.current;
    if (id != null && set !== null && set.size === 1 && set.has(id)) {
      useViewerStore.getState().clearGhost();
    }
  }, []);

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
                clearGhost();
              } else {
                // Not setGhostExceptEntities: that clears isolatedEntities
                // unconditionally and nothing captured it, so isolating a zone
                // and then fading around a member destroyed the isolation for
                // good. Writing both channels keeps it. The pair is coherent --
                // isolation filters, ghosting fades what survived it -- and
                // restoreVisibilityState documents it as reachable and legal.
                restoreVisibilityState({
                  isolated: isolatedEntities,
                  ghostExcept: new Set([selectedEntityId]),
                  hidden: hiddenEntities,
                });
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
