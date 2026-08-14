/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two interfaces the playground viewer is assembled from.
 *
 * `ViewerController` is what the agent's tool dispatcher drives (React ref on
 * `<PlaygroundViewer>`); `SceneHandle` is what the three.js scene factory
 * returns. They are near-identical by design — the component half is a thin
 * null-safe forwarder — and they live here so the component
 * (`PlaygroundViewer.tsx`), the scene (`playground-scene.ts`) and the
 * dispatcher can each reach them without importing one another.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { LoadedPlaygroundModel } from './playground-dispatcher';

export interface SelectionHit {
  expressId: number;
  globalId?: string;
  ifcType?: string;
}

export interface ViewerStatus {
  loaded: boolean;
  meshCount: number;
  selection: SelectionHit[];
  /**
   * The device refused a WebGL context, so the canvas never mounted (#2401).
   *
   * This is the difference between "not loaded yet" and "never will be":
   * `loaded` is false in both cases, but the verdict behind this flag is
   * latched for the whole session (`lib/webgl-capability.ts`), so no amount of
   * waiting or re-opening ever turns `loaded` true. The dispatcher branches on
   * it so the agent-facing answer can be terminal instead of the retry hint an
   * agent would otherwise follow forever (#2412).
   */
  webglUnavailable: boolean;
}

export type ColorTuple = [number, number, number, number];

export interface ViewerController {
  isLoaded(): boolean;
  status(): ViewerStatus;
  /** Colour the selected entities. Pass null/undefined to default to all. */
  colorize(args: { globalIds?: string[]; expressIds?: number[]; type?: string; color: ColorTuple }): { count: number };
  isolate(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  hide(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  show(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  reset(): void;
  flyTo(args: { globalIds?: string[]; expressIds?: number[] }): { count: number };
  setSection(args: { axis: 'x' | 'y' | 'z'; position: number }): void;
  clearSection(): void;
  colorByStorey(): { groups: number };
  colorByProperty(args: {
    type: string;
    pset: string;
    property: string;
    sample: (expressId: number) => string | number | boolean | null;
  }): { legend: Array<{ value: string; count: number; color: ColorTuple }> };
  getSelection(): SelectionHit[];
  setOnSelectionChange(handler: ((hits: SelectionHit[]) => void) | null): void;
  /** Multi-subscriber. Returns an unsubscribe — safe to call from tools
   *  that need a temporary listener without clobbering the panel's. */
  subscribeSelection(handler: (hits: SelectionHit[]) => void): () => void;
}

export interface SceneHandle {
  loadMeshes(meshes: MeshData[], model: LoadedPlaygroundModel): void;
  unloadModel(): void;
  colorize(args: { globalIds?: string[]; expressIds?: number[]; type?: string; color: ColorTuple }): { count: number };
  isolate(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  hide(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  show(args: { globalIds?: string[]; expressIds?: number[]; type?: string }): { count: number };
  reset(): void;
  flyTo(args: { globalIds?: string[]; expressIds?: number[] }): { count: number };
  setSection(args: { axis: 'x' | 'y' | 'z'; position: number }): void;
  clearSection(): void;
  colorByStorey(): { groups: number };
  colorByProperty(args: {
    type: string;
    pset: string;
    property: string;
    sample: (expressId: number) => string | number | boolean | null;
  }): { legend: Array<{ value: string; count: number; color: ColorTuple }> };
  getSelection(): SelectionHit[];
  setOnSelectionChange(handler: ((hits: SelectionHit[]) => void) | null): void;
  subscribeSelection(handler: (hits: SelectionHit[]) => void): () => void;
  dispose(): void;
}
