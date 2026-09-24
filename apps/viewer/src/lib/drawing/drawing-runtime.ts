/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 2D drawing's runtime (generation, persistence, the 3D cut feed) runs in
 * `DrawingRuntimeHost`, next to the federated geometry in `ViewportContainer`,
 * whether or not any drawing view is on screen. A view can be mounted anywhere
 * (the floating window today, the bottom strip next, a pop-out window), so the
 * host publishes what a view needs here instead of threading props (#5492).
 */

import { useSyncExternalStore } from 'react';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';

export interface DrawingRuntime {
  /** Model geometry with the workspace placement applied while a drawing is active. */
  geometryResult: GeometryResult | null | undefined;
  /** Coordinate frame of the unplaced source geometry (IFC annotation filtering). */
  sourceCoordinateInfo: CoordinateInfo | undefined;
  generateDrawing: (isRegenerate?: boolean) => Promise<void>;
  isRegenerating: boolean;
}

const NO_RUNTIME: DrawingRuntime = {
  geometryResult: null,
  sourceCoordinateInfo: undefined,
  generateDrawing: async () => {
    console.warn('[drawing] generateDrawing called with no DrawingRuntimeHost mounted');
  },
  isRegenerating: false,
};

let runtime: DrawingRuntime = NO_RUNTIME;
const listeners = new Set<() => void>();

export function publishDrawingRuntime(next: DrawingRuntime | null): void {
  runtime = next ?? NO_RUNTIME;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getRuntime(): DrawingRuntime {
  return runtime;
}

export function useDrawingRuntime(): DrawingRuntime {
  return useSyncExternalStore(subscribe, getRuntime, getRuntime);
}
