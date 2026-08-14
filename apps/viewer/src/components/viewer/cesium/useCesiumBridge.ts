/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coordinate bridge: where the model's georeference becomes a place on the
 * globe.
 *
 * Split out of CesiumOverlay.tsx (#2593). This is the file that decides WHERE
 * the model sits — ENU/ECEF framing, grid convergence, geoid undulation,
 * terrain clamping, and the placement draft the gizmo previews. Its history is
 * the georeferencing one (#1408 convergence, #1427 altitude, #2526 the
 * map-absolute guard), which is a different subject from what the world view
 * draws, and now reads as one.
 *
 * ORDERING NOTE: call this hook where its effect sat — after the viewer effect,
 * before the model hook, which rebuilds its matrix from `bridgeVersion`.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { createCesiumBridge, type CesiumBridge } from '@/lib/geo/cesium-bridge';
import {
  computeCesiumPlacement,
  shouldPreferOrthometricTerrain,
  shouldApplyGeoidUndulation,
  orthometricTargetForTerrain,
} from '@/lib/geo/cesium-placement';
import { egm96Undulation } from '@/lib/geo/egm96-undulation';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { getCesiumModule } from './cesium-module';

export interface UseCesiumBridgeParams {
  status: 'idle' | 'loading' | 'ready' | 'error';
  viewerRef: RefObject<InstanceType<typeof import('cesium').Viewer> | null>;
  /** Written by this hook; read by the model, camera and solar hooks. */
  bridgeRef: RefObject<CesiumBridge | null>;
  /** The camera-side bridge, which diverges from the model's only while a
   *  placement draft is previewing. */
  cameraBridgeRef: RefObject<CesiumBridge | null>;
  mapConversion?: MapConversion;
  cameraMapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale: number;
  storeyElevations?: Map<number, number>;
}

export interface UseCesiumBridgeResult {
  /** Bumped whenever the bridge is replaced, so dependants rebuild against it. */
  bridgeVersion: number;
}

export function useCesiumBridge({
  status,
  viewerRef,
  bridgeRef,
  cameraBridgeRef,
  mapConversion,
  cameraMapConversion,
  projectedCRS,
  coordinateInfo,
  lengthUnitScale,
  storeyElevations,
}: UseCesiumBridgeParams): UseCesiumBridgeResult {
  const terrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const heightsAreEllipsoidal = useViewerStore((s) => s.cesiumHeightsAreEllipsoidal);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const setCesiumTerrainHeight = useViewerStore((s) => s.setCesiumTerrainHeight);
  const setCesiumTerrainSource = useViewerStore((s) => s.setCesiumTerrainSource);
  const setCesiumTerrainSaveHeight = useViewerStore((s) => s.setCesiumTerrainSaveHeight);
  const setCesiumTerrainClipY = useViewerStore((s) => s.setCesiumTerrainClipY);
  // Last-known placement altitude (in metres) used to keep the user's WORLD
  // camera position stable across bridge rebuilds. When the user toggles the
  // clamp or edits OrthogonalHeight, the model placement changes and the
  // entire viewer→ECEF frame translates with it; we offset the IFC viewer's
  // camera Y by the inverse so the user perceives the model moving instead
  // of the camera being dragged along.
  const prevPlacementRef = useRef<number | null>(null);

  // Tracks bridge readiness as state (not just a ref) so dependants re-run.
  const [bridgeVersion, setBridgeVersion] = useState(0);

  // ─── Effect 2: Build the coordinate bridge with terrain-aware placement ─
  // Precomputes the model placement (floored to the visible surface when
  // necessary) BEFORE
  // building the bridge that the GLB and camera will share. This way the
  // model loads into Cesium at its final altitude — no post-load shifting,
  // no camera/model frame divergence, no compensation gymnastics.
  //
  // Sequence:
  //   1. Build a tentative bridge to recover the model's WGS84 lat/lon.
  //   2. Query terrain at that lat/lon (sync first, async with retry next).
  //   3. Auto-floor the model if its authored base sits below the visible surface.
  //   4. Rebuild the bridge with placementHeight baked into its enuToEcef
  //      origin so model matrix and camera frame share a single altitude.
  //   5. Push terrain-derived state (height, clip Y) and
  //      install the bridge.
  useEffect(() => {
    if (status !== 'ready' || !mapConversion || !projectedCRS) {
      bridgeRef.current = null;
      cameraBridgeRef.current = null;
      prevPlacementRef.current = null;
      return;
    }

    let cancelled = false;

    (async () => {
      const Cesium = getCesiumModule();
      const viewer = viewerRef.current;
      if (!Cesium || !viewer) return;

      const cameraConversion = cameraMapConversion ?? mapConversion;
      const usesSeparateCameraBridge = cameraConversion !== mapConversion;
      const cameraTentative = await createCesiumBridge(
        cameraConversion, projectedCRS, coordinateInfo, lengthUnitScale,
        undefined, heightsAreEllipsoidal,
      );
      if (cancelled) return;
      if (!cameraTentative) {
        bridgeRef.current = null;
        cameraBridgeRef.current = null;
        return;
      }

      // Query terrain at the model's location. queryTerrainHeight tries
      // Cesium's sync sources first (globe.getHeight, scene.sampleHeight),
      // then Open-Meteo as a fast network fallback that works even with
      // Google Photorealistic 3D Tiles (where there's no Cesium terrain
      // provider for getHeight to read). Cached per-session.
      const preferOrthometricTerrain = shouldPreferOrthometricTerrain(projectedCRS);
      let terrainSample = null;
      try {
        terrainSample = await cameraTentative.queryTerrainHeight(Cesium, viewer, {
          cacheNamespace: [
            terrainEnabled ? 'terrain' : 'ellipsoid',
            dataSource,
            preferOrthometricTerrain ? 'orthometric' : 'visual-surface',
          ].join(':'),
          preferOrthometric: preferOrthometricTerrain,
        });
      }
      catch (err) { console.warn('[CesiumOverlay] terrain query failed:', err); }
      if (cancelled) return;
      const terrainH = terrainSample?.height ?? null;
      const modelTentative = usesSeparateCameraBridge
        ? await createCesiumBridge(
            mapConversion, projectedCRS, coordinateInfo, lengthUnitScale,
            undefined, heightsAreEllipsoidal,
          )
        : cameraTentative;
      if (cancelled) return;
      if (!modelTentative) {
        bridgeRef.current = null;
        return;
      }
      // Placement is purely IFC-authored — no terrain/storey clamp. The
      // tentative bridges already carry the model's authored altitude
      // (IfcMapConversion.OrthogonalHeight + geometry origin), so they ARE
      // the final bridges. computeCesiumPlacement is still called for the
      // clip-plane Y; placementHeight == ifcOriginHeight.
      // The model origin is now ellipsoidal (orthometric + geoid N, #1355).
      // Express an orthometric terrain sample in the same ellipsoidal frame so
      // the below-terrain clip plane stays consistent; Cesium-sourced terrain
      // is already ellipsoidal and needs no shift.
      const terrainHForFrame = (terrainSample?.reference === 'orthometric' && terrainH !== null)
        ? terrainH + egm96Undulation(modelTentative.modelOrigin.latitude, modelTentative.modelOrigin.longitude)
        : terrainH;
      const placement = computeCesiumPlacement({
        coordinateInfo,
        projectedCRS,
        ifcOriginHeight: modelTentative.modelOrigin.height,
        terrainHeight: terrainHForFrame,
        storeyElevations,
      });
      const cameraPlacement = usesSeparateCameraBridge
        ? computeCesiumPlacement({
            coordinateInfo,
            projectedCRS,
            ifcOriginHeight: cameraTentative.modelOrigin.height,
            terrainHeight: terrainHForFrame,
            storeyElevations,
          })
        : placement;

      // The model bridge is the tentative one — placement == authored origin.
      const bridge = modelTentative;

      if (terrainSample) {
        setCesiumTerrainHeight(terrainH);
        setCesiumTerrainSource(
          `${terrainSample.source}${terrainSample.reference === 'orthometric' ? ' (orthometric)' : ''}`,
        );
        // Snap-to-terrain target in the OrthogonalHeight frame: the read path
        // places the base at OrthogonalHeight + geoid N, so persist the
        // ellipsoidal terrain altitude (terrainHForFrame) minus the same N that
        // was actually applied to this model. N mirrors the bridge: the EGM96
        // undulation, or 0 when heights are flagged ellipsoidal. Keeps the snap
        // button round-tripping (#1456).
        const appliedGeoidN = shouldApplyGeoidUndulation(heightsAreEllipsoidal)
          ? egm96Undulation(modelTentative.modelOrigin.latitude, modelTentative.modelOrigin.longitude)
          : 0;
        setCesiumTerrainSaveHeight(
          terrainHForFrame !== null
            ? orthometricTargetForTerrain(terrainHForFrame, appliedGeoidN)
            : null,
        );
        // terrainClipY stays in viewer-space; it represents the world terrain
        // altitude expressed in the camera bridge's committed frame. Draft
        // placement edits must not move this floor, or the camera will drift.
        setCesiumTerrainClipY(cameraPlacement.terrainClipY);
      } else {
        // Failed re-query (offline, API down) — clear stale store fields so
        // the clip plane doesn't drift relative to the new bridge.
        setCesiumTerrainHeight(null);
        setCesiumTerrainSource(null);
        setCesiumTerrainSaveHeight(null);
        setCesiumTerrainClipY(null);
      }

      // World-camera stability: when this rebuild changes the placement
      // altitude (surface floor or OrthogonalHeight edited), shift the IFC
      // viewer-space camera Y by the inverse delta so the user's WORLD
      // camera ECEF position stays put. Without this, the entire frame
      // translates with the model and edits feel like the camera is
      // moving instead of the model — exactly what the user reported.
      const prevPlacement = prevPlacementRef.current;
      if (!usesSeparateCameraBridge) {
        prevPlacementRef.current = placement.placementHeight;
      }
      if (!usesSeparateCameraBridge && prevPlacement !== null) {
        const dh = placement.placementHeight - prevPlacement;
        // 5 cm threshold — rejects float jitter from cached terrain reads
        // re-flowing through the same effect, while a real placement edit
        // is always far larger.
        if (Math.abs(dh) > 0.05) {
          const renderer = getGlobalRenderer();
          if (renderer) {
            const cam = renderer.getCamera();
            const pos = cam.getPosition();
            cam.setPosition(pos.x, pos.y - dh, pos.z);
          }
        }
      }

      // Camera bridge: the separate camera-tentative when a placement draft
      // is previewing (camera holds the base frame while the model moves),
      // otherwise the model bridge itself. Both are already at their
      // authored altitude — no placement-override rebuild.
      const cameraBridge = usesSeparateCameraBridge ? cameraTentative : bridge;

      bridgeRef.current = bridge;
      cameraBridgeRef.current = cameraBridge;
      setBridgeVersion((v) => v + 1);
    })();

    return () => { cancelled = true; };
    // terrainEnabled and ionToken intentionally omitted — Effect 1 already
    // owns those (it destroys/recreates the viewer when they change), and
    // listing them here would cause a redundant bridge rebuild while the
    // viewer is being torn down.
  }, [
    status,
    mapConversion,
    cameraMapConversion,
    projectedCRS,
    coordinateInfo,
    lengthUnitScale,
    terrainEnabled,
    heightsAreEllipsoidal,
    dataSource,
    storeyElevations,
    setCesiumTerrainHeight,
    setCesiumTerrainSource,
    setCesiumTerrainSaveHeight,
    setCesiumTerrainClipY,
  ]);

  return { bridgeVersion };
}
