/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useSyncExternalStore } from 'react';
import { getGlobalRenderer, readInstancedMembershipRevision, readInstancedSceneRevision, subscribeGlobalRenderer } from '../lib/renderer-ref.js';

export function readSceneTriangleCounts(): ReadonlyMap<number, number> | null {
  const scene = getGlobalRenderer()?.getScene();
  return scene?.isTriangleCountReplayComplete?.() ? scene.getTriangleCounts?.() ?? null : null;
}
function subscribe(listener: () => void): () => void {
  let releaseScene: (() => void) | undefined;
  const bind = () => {
    releaseScene?.();
    releaseScene = getGlobalRenderer()?.getScene?.()?.onGeometryChange?.(listener);
    listener();
  };
  const releaseRenderer = subscribeGlobalRenderer(bind);
  bind();
  return () => { releaseRenderer(); releaseScene?.(); };
}
/** A stable snapshot changes only with source geometry; selection and colour
 * changes do not require rescanning meshes or expanding GPU instances. */
export function useSceneTriangleCounts() {
  return useSyncExternalStore(subscribe, readSceneTriangleCounts, () => null);
}

export function useInstancedSceneRevision(enabled: boolean): string {
  return useSyncExternalStore(enabled ? subscribe : noSubscription, enabled ? readInstancedSceneRevision : emptyRevision, emptyRevision);
}

export function useInstancedMembershipRevision(enabled: boolean): string {
  return useSyncExternalStore(enabled ? subscribe : noSubscription, enabled ? readInstancedMembershipRevision : emptyRevision, emptyRevision);
}

const emptyRevision = () => '';
const noSubscription = () => () => {};
