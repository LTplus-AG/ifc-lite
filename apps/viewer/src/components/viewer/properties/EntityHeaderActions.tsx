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
  const setGhostExceptEntities = useViewerStore((s) => s.setGhostExceptEntities);

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
                setGhostExceptEntities(null);
              } else {
                setGhostExceptEntities(new Set([selectedEntityId]));
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
