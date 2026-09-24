/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The SVG + DOM layer shell shared by `SceneOverlayRoot` (real renderer)
 * and the test harness (stub projector) — split out so a test can mount
 * real portal targets without depending on `SceneProjectorProvider`
 * finding a live `@ifc-lite/renderer` (#5486).
 */

import { useState, type ReactNode, type RefObject } from 'react';
import { SceneLayersContext } from './SceneLayers';
import { OverlayDefs } from './OverlayDefs';

export interface SceneOverlayLayersProps {
  children?: ReactNode;
  /** Attached to the root div — `RendererProjectorSource` scopes its canvas lookup off it. Optional for tests that don't need canvas scoping. */
  rootRef?: RefObject<HTMLDivElement | null>;
}

export function SceneOverlayLayers({ children, rootRef }: SceneOverlayLayersProps) {
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const [dom, setDom] = useState<HTMLDivElement | null>(null);

  return (
    <SceneLayersContext.Provider value={{ svg, dom }}>
      <div ref={rootRef} className="pointer-events-none absolute inset-0 z-(--z-scene)" data-scene-overlay-root>
        <svg ref={setSvg} className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          <OverlayDefs />
        </svg>
        <div ref={setDom} className="pointer-events-none absolute inset-0" />
      </div>
      {children}
    </SceneLayersContext.Provider>
  );
}
