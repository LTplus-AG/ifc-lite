/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mounts the active tool's HUD presence from the `TOOL_HUD` table (#5503,
 * charter #5478): its bar into the HUD's top-center region, its hint into
 * the bottom-center region (both through `HudItem`, the only placement
 * knob a tool gets), and its scene layer (`entry.Scene`) as a plain child —
 * `WorldLabel` / `CursorInput` etc. in a tool's scene layer reach the
 * shared projector through `ViewportContainer`'s `SceneOverlayRoot`, the
 * ancestor `<ToolOverlays>` now renders under.
 *
 * Until #5512, this component mounted its OWN `SceneOverlayRoot` (#5486
 * kernel, first consumer #5502) — a second projector/layer instance
 * alongside `ViewportContainer`'s, because at the time every sibling
 * overlay (`AnnotationLayer`, `BCFOverlay`, `CollabPresenceLayer`,
 * `BasepointOverlay`, `ZoneOverlay`) still ran its own rAF loop and had no
 * reason to share one. Now that all of them are on the kernel, one root
 * per viewport is enough: `ViewportContainer` mounts `<ToolOverlays>`
 * inside its own `<SceneOverlayRoot>` instead of this component owning a
 * second one — two `SceneOverlayRoot`s would mean two independent rAF
 * loops and two competing `<defs>` mounting the SAME filter/marker ids
 * (`OverlayDefs`' own docblock: "a second `<defs>` mounting the same id in
 * the same document is undefined behaviour — the browser picks one").
 */

import { Suspense, useEffect, type ReactNode } from 'react';
import { RepositionRuntimeHost } from './reposition/RepositionRuntimeHost';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { HudHint, HudItem } from '../viewport-ui/hud';
import { TOOL_HUD, isToolId } from '@/lib/viewport-ui/tool-hud-registry';
import { preloadSectionTool } from '@/lib/viewport-ui/lazy-section-tool';
import { WorkplaneScene } from './model/WorkplaneScene';
import { ModelOnboardingHint } from './model/ModelOnboardingHint';

export function ToolOverlays(): ReactNode {
  const activeTool = useViewerStore((s) => s.activeTool);
  const repositionOpen = useViewerStore((s) => s.repositionOpen);
  const modelWorkspace = useViewerStore((s) => s.workspaceMode === 'model');
  useEffect(() => {
    if (repositionOpen && activeTool !== 'select') useViewerStore.getState().closeReposition();
  }, [repositionOpen, activeTool]);
  // The Section tool's code is not in the entry chunk (#7616): fetch it once the browser is idle, so the first open is instant.
  useEffect(() => whenIdle(preloadSectionTool), []);
  if (repositionOpen && activeTool === 'select') return <RepositionRuntimeHost />;

  const entry = isToolId(activeTool) ? TOOL_HUD[activeTool] : undefined;
  return (
    <>
      {/* The Model workspace's own layer, under whatever tool runs in it (#6232). */}
      {modelWorkspace && <WorkplaneScene />}
      {modelWorkspace && <ModelOnboardingHint />}
      {entry?.Bar && (
        <HudItem region="top-center" order={0}>
          <Suspense fallback={null}><entry.Bar /></Suspense>
        </HudItem>
      )}
      {entry?.Scene && <Suspense fallback={null}><entry.Scene /></Suspense>}
      {entry?.hint && <ToolHint hint={entry.hint} />}
    </>
  );
}

/** Run `task` when the browser is idle (or soon after, where there is no idle callback); the returned function cancels it. */
function whenIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(task, { timeout: 5000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 3000);
  return () => window.clearTimeout(id);
}

function ToolHint({ hint }: { hint: string }): ReactNode {
  const { t } = useTranslation();
  return (
    <HudItem region="bottom-center" order={0}>
      <HudHint>{t(hint as TranslationKey)}</HudHint>
    </HudItem>
  );
}
