/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { buildCesiumModelGLB, cesiumModelGLBKey, type CesiumModelGLBInput } from '@/lib/geo/cesium-model-glb';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { swapCesiumModel } from '@/lib/geo/cesium-model-swap';
import { whenModelRenderable, type CesiumModelPrimitive } from './cesium-model-renderable';
import type { CesiumViewerLifetime } from './cesium-viewer-lifetime';

export type CesiumModelGlbCache = { key: string; glb: Uint8Array } | null;
type ModelOwnership = 'standalone' | 'collection' | 'released';

export function buildCesiumModelMatrix(
  Cesium: typeof import('cesium'),
  bridge: CesiumBridge,
  coordinateInfo: CoordinateInfo | undefined,
) {
  const bounds = coordinateInfo?.originalBounds;
  const mvx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const mvy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const mvz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
  const origin = Cesium.Cartesian3.fromDegrees(
    bridge.modelOrigin.longitude, bridge.modelOrigin.latitude, bridge.modelOrigin.height,
  );
  const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const rot = bridge.viewerRotation;
  const ifcToEnu = new Cesium.Matrix4(
    rot.eastFromVx, 0, rot.eastFromVz, -(rot.eastFromVx * mvx + rot.eastFromVz * mvz),
    rot.northFromVx, 0, rot.northFromVz, -(rot.northFromVx * mvx + rot.northFromVz * mvz),
    0, bridge.viewerUpScale, 0, -bridge.viewerUpScale * mvy,
    0, 0, 0, 1,
  );
  return Cesium.Matrix4.multiply(enuToEcef, ifcToEnu, new Cesium.Matrix4());
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
  let model: CesiumModelPrimitive | null = null;
  let ownership: ModelOwnership = 'released';
  try {
    const key = cesiumModelGLBKey(glbInput);
    if (modelRef.current && loadedKey === key) return;
    let glbBytes: Uint8Array;
    if (glbCacheRef.current?.key === key) {
      glbBytes = glbCacheRef.current.glb;
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (isSuperseded()) return;
      const built = buildCesiumModelGLB(glbInput);
      glbBytes = built.glb;
      glbCacheRef.current = { key: built.key, glb: built.glb };
    }
    if (isSuperseded()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (isSuperseded()) return;

    const glbUrl = URL.createObjectURL(new Blob([glbBytes as BlobPart], { type: 'model/gltf-binary' }));
    try {
      model = await Cesium.Model.fromGltfAsync({
        url: glbUrl, modelMatrix: buildCesiumModelMatrix(Cesium, bridge, coordinateInfo),
        shadows: Cesium.ShadowMode.DISABLED, upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X,
      });
      ownership = 'standalone';
      const ibl = (model as unknown as {
        imageBasedLighting?: { sphericalHarmonicCoefficients: unknown };
      }).imageBasedLighting;
      if (ibl) {
        const ambient = new Cesium.Cartesian3(0.72, 0.72, 0.75);
        const zero = Cesium.Cartesian3.ZERO;
        ibl.sphericalHarmonicCoefficients = [ambient, zero, zero, zero, zero, zero, zero, zero, zero];
      }
    } finally {
      URL.revokeObjectURL(glbUrl);
    }
    if (isSuperseded()) {
      model.destroy?.();
      ownership = 'released';
      return;
    }
    ownership = 'collection';
    // Viewer.destroy() invalidates `viewer.scene`; retain the collection that
    // accepted this primitive before readiness can suspend.
    const scene = viewer.scene;
    const primitives = scene.primitives;
    let published = false;
    const outcome = await swapCesiumModel(
      primitives, modelRef.current, model,
      (next) => whenModelRenderable(viewer, next, 5_000, lifetime), isSuperseded,
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
