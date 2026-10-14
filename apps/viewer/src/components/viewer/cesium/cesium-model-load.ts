/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { buildCesiumModelGLBParts, cesiumModelGLBKey, type CesiumModelGLBInput, type CesiumModelGLBPart } from '@/lib/geo/cesium-model-glb';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { buildViewerToEcefMatrix } from '@/lib/geo/cesium-viewer-frame';
import { swapCesiumModel } from '@/lib/geo/cesium-model-swap';
import type { CesiumModelPrimitive } from './cesium-model-renderable';
import { createCesiumModelOwner, type CesiumModelOwner } from './cesium-model-owner';
import type { CesiumViewerLifetime } from './cesium-viewer-lifetime';

export type CesiumModelGlbCache = { key: string; parts: CesiumModelGLBPart[] } | null;
type ModelOwnership = 'standalone' | 'collection' | 'released';

export function buildCesiumModelMatrix(
  Cesium: typeof import('cesium'),
  bridge: CesiumBridge,
  coordinateInfo: CoordinateInfo | undefined,
) {
  return buildViewerToEcefMatrix(
    Cesium, bridge.modelOrigin, bridge.viewerRotation, bridge.viewerUpScale, coordinateInfo,
  );
}

export interface LoadCesiumModelParams {
  Cesium: typeof import('cesium');
  viewer: InstanceType<typeof import('cesium').Viewer>;
  lifetime: CesiumViewerLifetime;
  bridge: CesiumBridge;
  coordinateInfo: CoordinateInfo | undefined;
  glbInput: CesiumModelGLBInput;
  glbCacheRef: MutableRefObject<CesiumModelGlbCache>;
  modelRef: MutableRefObject<CesiumModelPrimitive | null>;
  loadedKey: string | null;
  isSuperseded: () => boolean;
  onInstalled(model: CesiumModelPrimitive, key: string): void;
}

/** Build and install one model while making its current owner explicit (#4807). */
export async function loadCesiumModel({
  Cesium, viewer, lifetime, bridge, coordinateInfo, glbInput, glbCacheRef, modelRef, loadedKey,
  isSuperseded, onInstalled,
}: LoadCesiumModelParams): Promise<void> {
  let model: CesiumModelOwner | null = null;
  let ownership: ModelOwnership = 'released';
  try {
    const key = cesiumModelGLBKey(glbInput);
    if (modelRef.current && loadedKey === key) return;
    let parts: CesiumModelGLBPart[];
    if (glbCacheRef.current?.key === key) {
      parts = glbCacheRef.current.parts;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (isSuperseded()) return;
      const built = buildCesiumModelGLBParts(glbInput);
      parts = built.parts;
      glbCacheRef.current = built;
    }
    if (isSuperseded()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (isSuperseded()) return;

    model = createCesiumModelOwner(Cesium, buildCesiumModelMatrix(Cesium, bridge, coordinateInfo));
    ownership = 'standalone';
    for (const part of parts) {
      const glbUrl = URL.createObjectURL(new Blob([part.glb as BlobPart], { type: 'model/gltf-binary' }));
      try {
        const child = await Cesium.Model.fromGltfAsync({
          url: glbUrl, modelMatrix: model.modelMatrix,
          shadows: Cesium.ShadowMode.DISABLED, upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X,
        });
        // Transfer immediately: later load failure or cancellation releases all
        // accepted children through the one standalone owner.
        model.addModel(child, part.castsShadows);
        const ibl = child.imageBasedLighting;
        if (ibl) {
          const ambient = new Cesium.Cartesian3(0.72, 0.72, 0.75);
          const zero = Cesium.Cartesian3.ZERO;
          ibl.sphericalHarmonicCoefficients = [ambient, zero, zero, zero, zero, zero, zero, zero, zero];
        }
      } finally {
        URL.revokeObjectURL(glbUrl);
      }
      if (isSuperseded()) break;
    }
    if (isSuperseded()) {
      model.destroy?.();
      ownership = 'released';
      return;
    }
    // Viewer.destroy() invalidates `viewer.scene`; retain the collection that
    // accepted this primitive before readiness can suspend.
    const owner = model;
    const scene = viewer.scene;
    const primitives = scene.primitives;
    let published = false;
    ownership = 'collection';
    const outcome = await swapCesiumModel(
      primitives, modelRef.current, owner,
      () => owner.whenRenderable(viewer, lifetime), isSuperseded,
      (next) => {
        if (!lifetime.isLive(viewer) || primitives.isDestroyed()) return;
        // This callback runs inside the swap commit, before its promise
        // resolves. A cleanup that lands in the caller's continuation gap can
        // therefore remove this exact primitive instead of a destroyed
        // predecessor or a null ref.
        ownership = 'released';
        modelRef.current = next;
        onInstalled(next, key);
        published = true;
        if (lifetime.isLive(viewer) && !primitives.isDestroyed()) scene.requestRender();
      },
    );
    if (outcome === 'superseded') {
      ownership = 'released';
      return;
    }
    // A synchronous collection retirement can make the commit callback decline
    // publication. The collection owns (and has already released) the model.
    if (!published) ownership = 'released';
  } catch (error) {
    console.warn('[CesiumOverlay] Failed to load IFC model into Cesium:', error);
    // A collection owns every primitive handed to swap; it alone may release
    // that primitive. This avoids a pending replacement's double-destroy.
    if (model && ownership === 'standalone') model.destroy?.();
  }
}
