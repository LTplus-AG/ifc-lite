/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mounts the active tool's HUD presence from the `TOOL_HUD` table (#5503,
 * charter #5478): its bar into the HUD's top-center region, its hint into
 * the bottom-center region (both through `HudItem`, the only placement
 * knob a tool gets), and its scene layer under the one `SceneOverlayRoot`
 * this component owns — so `WorldLabel` / `CursorInput` in a tool's scene
 * layer find the shared projector without each tool mounting a root.
 *
 * `SceneOverlayRoot` (#5486 kernel, first consumer #5502) lives here rather
 * than in `ViewportContainer` (at its module budget): this is the one
 * always-mounted descendant of the `[data-viewport]` element that every
 * tool renders under, and the root's own layer div is a sibling of the tool
 * overlays in the same viewport container, so `RendererProjectorSource`
 * still resolves the canvas through `closest('[data-viewport]')`. Overlays
 * that are siblings of this component (`AnnotationLayer`, `BCFOverlay`,
 * `CollabPresenceLayer`) migrate onto the kernel in #5510-#5512 and lift
 * the root up when they do.
 */

import { useEffect, type ReactNode } from 'react';
import { RepositionRuntimeHost } from './reposition/RepositionRuntimeHost';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { HudHint, HudItem } from '../viewport-ui/hud';
import { SceneOverlayRoot } from '../viewport-ui/scene';
import { TOOL_HUD, isToolId } from '@/lib/viewport-ui/tool-hud-registry';

export function ToolOverlays() {
  return <SceneOverlayRoot><ToolOverlaysBody /></SceneOverlayRoot>;
}

function ToolOverlaysBody(): ReactNode {
  const activeTool = useViewerStore((s) => s.activeTool);
  const repositionOpen = useViewerStore((s) => s.repositionOpen);
  useEffect(() => {
    if (repositionOpen && activeTool !== 'select') useViewerStore.getState().closeReposition();
  }, [repositionOpen, activeTool]);
  if (repositionOpen && activeTool === 'select') return <RepositionRuntimeHost />;

  const entry = isToolId(activeTool) ? TOOL_HUD[activeTool] : undefined;
  return (
    <>
      {entry?.Bar && (
        <HudItem region="top-center" order={0}>
          <entry.Bar />
        </HudItem>
      )}
      {entry?.Scene && <entry.Scene />}
      {entry?.hint && <ToolHint hint={entry.hint} />}
    </>
  );
}

function ToolHint({ hint }: { hint: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <HudItem region="bottom-center" order={0}>
      <HudHint>{t(hint as TranslationKey)}</HudHint>
    </HudItem>
  );
}
