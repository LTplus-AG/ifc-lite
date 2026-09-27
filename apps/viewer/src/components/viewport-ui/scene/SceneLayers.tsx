/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two layers `SceneOverlayRoot` mounts — one SVG, one DOM — and the
 * portal hook primitives use to reach them regardless of where in the tree
 * they're rendered (#5486). SVG primitives (`Handle`, `AxisArrow`,
 * `SnapGlyph`, `Leader`, `Pin`, `PlaneOutline`) portal into the SVG layer;
 * DOM primitives (`WorldLabel`, `AnchoredCard`, `CursorInput`) portal into
 * the DOM layer. Neither layer is exposed directly — always go through
 * `useSceneLayer`.
 */

import { createContext, useContext } from 'react';

export interface SceneLayers {
  svg: SVGSVGElement | null;
  dom: HTMLDivElement | null;
}

export const SceneLayersContext = createContext<SceneLayers>({ svg: null, dom: null });

export function useSceneLayer(kind: 'svg'): SVGSVGElement | null;
export function useSceneLayer(kind: 'dom'): HTMLDivElement | null;
export function useSceneLayer(kind: 'svg' | 'dom'): SVGSVGElement | HTMLDivElement | null {
  const layers = useContext(SceneLayersContext);
  return kind === 'svg' ? layers.svg : layers.dom;
}
