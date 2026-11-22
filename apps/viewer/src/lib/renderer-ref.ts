/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { objectIdentity } from '../utils/objectIdentity.js';

let globalRendererRef: RefObject<Renderer | null> | null = null;
const rendererRefListeners = new Set<() => void>();
export function subscribeGlobalRenderer(listener: () => void): () => void {
  rendererRefListeners.add(listener);
  return () => { rendererRefListeners.delete(listener); };
}

/**
 * Set the global renderer reference (called by ViewportContainer)
 */
export function setGlobalRendererRef(ref: RefObject<Renderer | null> | null): void {
  globalRendererRef = ref;
  for (const listener of rendererRefListeners) listener();
}

/**
 * Get the global renderer instance (for direct rendering control, e.g., IDS snapshot capture)
 */
export function getGlobalRenderer(): Renderer | null {
  return globalRendererRef?.current ?? null;
}

/** Cached IFC loads restore the instance buffers directly into the scene. */
export function readInstancedSceneRevision(): string {
  const renderer = getGlobalRenderer();
  const count = renderer?.getScene?.()?.getInstancedEntityCount?.() ?? 0;
  return count ? `${objectIdentity(renderer)}:${renderer?.getPickGeometryRevision?.() ?? count}` : '';
}
