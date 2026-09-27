/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SceneOverlayRoot`: one SVG layer plus one DOM layer over the 3D
 * viewport, `pointer-events-none` at the root so orbit/pick still reaches
 * the canvas underneath (#5486, charter #5478). Mount once per viewport;
 * primitives elsewhere in the tree reach the layers through
 * `useSceneLayer` (portals) and register their world point through
 * `useWorldAnchor` (the shared projector, `SceneProjectorProvider`).
 *
 * Mounted once in `ViewportContainer`, wrapping `AnnotationLayer`,
 * `CollabPresenceLayer` (`PeerPresenceLayer`) and `BCFOverlay` (#5511) — the
 * remaining hand-rolled rAF overlays it replaces (the section gizmo and pick
 * preview moved in #5501; `BasepointOverlay` migrates in #5512).
 */

import { useRef, type ReactNode } from 'react';
import { SceneProjectorProvider } from './SceneProjectorProvider';
import { SceneOverlayLayers } from './SceneOverlayLayers';

export interface SceneOverlayRootProps {
  /** World-anchored primitives (`Handle`, `WorldLabel`, …), rendered anywhere in the tree — they portal into the layers below. */
  children?: ReactNode;
}

export function SceneOverlayRoot({ children }: SceneOverlayRootProps) {
  // A stable ref object (not `useState`) — `RendererProjectorSource` reads
  // `.current` on every tick, so its identity must survive re-renders.
  const containerRef = useRef<HTMLDivElement | null>(null);

  return (
    <SceneProjectorProvider containerRef={containerRef}>
      <SceneOverlayLayers rootRef={containerRef}>{children}</SceneOverlayLayers>
    </SceneProjectorProvider>
  );
}
