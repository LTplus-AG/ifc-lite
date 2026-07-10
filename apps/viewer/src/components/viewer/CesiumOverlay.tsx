/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CesiumOverlay — renders Google Photorealistic 3D Tiles behind the WebGPU
 * canvas, providing real-world 3D context for georeferenced IFC models.
 *
 * Architecture:
 *   - A separate <div> behind the WebGPU <canvas> (z-index layering)
 *   - WebGPU canvas uses transparent clear color so Cesium shows through
 *   - Camera is synchronized every frame from the IFC viewer camera
 *   - CesiumJS is lazy-loaded on first activation to avoid bundle bloat
 *   - User controls remain on the WebGPU canvas; Cesium's are disabled
 *
 * Live edit support:
 *   - When georef props change (e.g. user edits EPSG, eastings, rotation),
 *     the coordinate bridge is rebuilt and the globe flies to the new location
 *   - The Cesium viewer itself is NOT recreated — only the bridge is updated
 */

import { useEffect, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { createCesiumBridge, type CesiumBridge } from '@/lib/geo/cesium-bridge';
import {
  computeCesiumPlacement,
  shouldPreferOrthometricTerrain,
  shouldApplyGeoidUndulation,
  orthometricTargetForTerrain,
} from '@/lib/geo/cesium-placement';
import { egm96Undulation } from '@/lib/geo/egm96-undulation';
import { buildMergedGLB } from '@/lib/geo/cesium-glb';
import { applySolarScene, SunPathDome } from '@/lib/geo/cesium-sun';
import { sunPosition, sunTimes } from '@ifc-lite/solar';

// Lazy-loaded Cesium module and CSS
let cesiumPromise: Promise<typeof import('cesium')> | null = null;
let cesiumModule: typeof import('cesium') | null = null;
function loadCesium() {
  if (!cesiumPromise) {
    cesiumPromise = Promise.all([
      import('cesium'),
      import('cesium/Build/Cesium/Widgets/widgets.css'),
    ]).then(([cesium]) => {
      cesiumModule = cesium;
      return cesium;
    });
  }
  return cesiumPromise;
}



/**
 * Build a Cesium model matrix for placing the IFC model in ECEF.
 * Extracted as a pure function so it can be called from both
 * the GLB load effect (initial) and the matrix update effect (instant).
 */
function buildModelMatrix(
  Cesium: typeof import('cesium'),
  bridge: CesiumBridge,
  coordinateInfo: CoordinateInfo | undefined,
) {
  // GLB vertices are in viewer-space metres (geometry engine converts during
  // extraction; the effective map scale is already folded into the rotation).
  const bounds = coordinateInfo?.originalBounds;
  // Viewer bounds are already in metres (geometry engine converts from IFC native unit)
  const mvx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const mvy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const mvz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;

  // bridge.modelOrigin.height is the placement altitude — Effect 2 already
  // baked terrain clamping (when applicable) into it before constructing the
  // bridge, so there's no per-frame clamp adjustment to make here.
  const origin = Cesium.Cartesian3.fromDegrees(
    bridge.modelOrigin.longitude, bridge.modelOrigin.latitude, bridge.modelOrigin.height,
  );
  const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  // No lengthUnitScale here: viewer-space GLB vertices are already in metres.
  // Reuse the bridge's convergence-corrected viewer-to-ENU rotation so the
  // model geometry and the camera frame agree on north; a grid-only rotation
  // here would leave the model rotated by the meridian convergence off the
  // true-north basemap (up to ~8 deg for Krovak). See #1408.
  const rot = bridge.viewerRotation;
  const tx = -(rot.eastFromVx * mvx + rot.eastFromVz * mvz);
  const ty = -(rot.northFromVx * mvx + rot.northFromVz * mvz);
  const tz = -mvy;
  const ifcToEnu = new Cesium.Matrix4(
    rot.eastFromVx,  0, rot.eastFromVz,  tx,
    rot.northFromVx, 0, rot.northFromVz, ty,
    0,               1, 0,               tz,
    0,               0, 0,               1,
  );
  return Cesium.Matrix4.multiply(enuToEcef, ifcToEnu, new Cesium.Matrix4());
}

export interface CesiumOverlayProps {
  mapConversion?: MapConversion;
  cameraMapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  geometryResult?: GeometryResult | null;
  /** IFC project length unit → metres (e.g. 0.001 for mm models). Default 1. */
  lengthUnitScale?: number;
  /** IfcBuildingStorey elevations (express id → metres, viewer-Y aligned).
   *  Used to clamp the model's ground-floor storey to terrain instead of
   *  the lowest geometry vertex (which can be a basement or foundation). */
  storeyElevations?: Map<number, number>;
}

export function CesiumOverlay({
  mapConversion,
  cameraMapConversion,
  projectedCRS,
  coordinateInfo,
  geometryResult,
  lengthUnitScale = 1,
  storeyElevations,
}: CesiumOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<typeof import('cesium').Viewer> | null>(null);
  const bridgeRef = useRef<CesiumBridge | null>(null);
  const cameraBridgeRef = useRef<CesiumBridge | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Tracks bridge readiness as state (not just a ref) so terrain query effect re-runs
  const [bridgeVersion, setBridgeVersion] = useState(0);

  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const ionToken = useViewerStore((s) => s.cesiumIonToken);
  const terrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const heightsAreEllipsoidal = useViewerStore((s) => s.cesiumHeightsAreEllipsoidal);
  const terrainClipY = useViewerStore((s) => s.cesiumTerrainClipY);
  const setCesiumTerrainHeight = useViewerStore((s) => s.setCesiumTerrainHeight);
  const setCesiumTerrainSource = useViewerStore((s) => s.setCesiumTerrainSource);
  const setCesiumTerrainSaveHeight = useViewerStore((s) => s.setCesiumTerrainSaveHeight);
  const setCesiumTerrainClipY = useViewerStore((s) => s.setCesiumTerrainClipY);
  const setCesiumGlbLoaded = useViewerStore((s) => s.setCesiumGlbLoaded);

  // Solar study state — drives the sun-path dome + shadow study.
  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const solarDateMs = useViewerStore((s) => s.solarDateMs);
  const solarShowSunPath = useViewerStore((s) => s.solarShowSunPath);
  const solarShowShadows = useViewerStore((s) => s.solarShowShadows);
  const setSolarSunInfo = useViewerStore((s) => s.setSolarSunInfo);
  // Environment sky toggle — atmosphere + sun + fog in geo mode.
  const envSkyEnabled = useViewerStore((s) => s.envSkyEnabled);
  // Re-run the solar effect once the deferred GLB load completes, so the IFC
  // model's shadow mode is applied even when the study was enabled before the
  // model finished loading into Cesium.
  const cesiumGlbLoaded = useViewerStore((s) => s.cesiumGlbLoaded);

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  const cesiumModelRef = useRef<{ modelMatrix: any; shadows?: any; destroy?: () => void } | null>(null);
  const glbCacheRef = useRef<{ meshCount: number; glb: Uint8Array } | null>(null);
  // Active 3D context tileset (Google Photorealistic / OSM buildings) — kept so
  // solar mode can toggle its shadow casting/receiving.
  const tilesetRef = useRef<{ shadows?: any } | null>(null);
  // Active sun-path dome entity collection (null when solar study is off).
  const sunPathDomeRef = useRef<SunPathDome | null>(null);
  // UTC calendar day the dome's static geometry (day-arc, analemmas) was built
  // for. Intra-day time scrubs only move the sun marker; a new day rebuilds.
  const sunPathDomeDayRef = useRef<string | null>(null);
  // Whether the solar study has ever touched Cesium scene state. Guards us
  // from mutating the default (non-solar) lighting on plain mount.
  const solarTouchedSceneRef = useRef(false);

  // Last-known placement altitude (in metres) used to keep the user's WORLD
  // camera position stable across bridge rebuilds. When the user toggles the
  // clamp or edits OrthogonalHeight, the model placement changes and the
  // entire viewer→ECEF frame translates with it; we offset the IFC viewer's
  // camera Y by the inverse so the user perceives the model moving instead
  // of the camera being dragged along.
  const prevPlacementRef = useRef<number | null>(null);

  // ─── Effect 1: Create/destroy the Cesium viewer (heavy, rare) ───────────
  // Only depends on cesiumEnabled, ionToken, terrainEnabled, dataSource.
  // NOT on mapConversion/projectedCRS — those are handled by Effect 2.
  useEffect(() => {
    if (!cesiumEnabled || !containerRef.current) return;

    let cancelled = false;
    setStatus('loading');
    setError(null);

    (async () => {
      try {
        const Cesium = await loadCesium();
        if (cancelled || !containerRef.current) return;

        // Configure Cesium ion token if provided
        if (ionToken) {
          Cesium.Ion.defaultAccessToken = ionToken;
        }

        const viewer = new Cesium.Viewer(containerRef.current, {
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          // Cesium ion ToS requires visible attribution — use a small container
          // at bottom of the overlay rather than hiding credits entirely.
          msaaSamples: 1,
          requestRenderMode: true,
          maximumRenderTimeChange: Infinity,
          baseLayer: false,
        });

        if (cancelled) { viewer.destroy(); return; }

        // Disable Cesium's user input — the IFC viewer drives the camera,
        // and any input Cesium intercepts (even a stray wheel/touch event
        // past pointer-events:none) interferes with our orbit/zoom and
        // produces "stuck to terrain" symptoms. enableInputs is the
        // master kill-switch; the per-mode flags below are belt-and-braces.
        const scene = viewer.scene;
        const sscc = scene.screenSpaceCameraController;
        sscc.enableInputs = false;
        sscc.enableRotate = false;
        sscc.enableTranslate = false;
        sscc.enableZoom = false;
        sscc.enableTilt = false;
        sscc.enableLook = false;
        sscc.enableCollisionDetection = false;
        sscc.minimumZoomDistance = 0;
        sscc.maximumZoomDistance = Infinity;
        // Enable depth testing so the model (and other objects) get clipped
        // by terrain — prevents seeing underground portions.
        scene.globe.depthTestAgainstTerrain = true;

        // Move credit/logo from bottom-left to top-left to avoid overlap
        // with other UI elements.
        const bottomContainer = viewer.bottomContainer as HTMLElement;
        if (bottomContainer) {
          bottomContainer.style.top = '0';
          bottomContainer.style.bottom = 'auto';
          bottomContainer.style.left = '0';
          bottomContainer.style.right = 'auto';
        }

        // Disable skybox/atmosphere/fog for transparent compositing.
        // (The Sun & Sky panel's Sky toggle re-enables atmosphere/sun/fog
        // via Effect 4b.)
        if (scene.skyBox) (scene.skyBox as any).show = false;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
        scene.fog.enabled = false;
        scene.globe.showGroundAtmosphere = false;
        scene.backgroundColor = Cesium.Color.TRANSPARENT;
        scene.globe.baseColor = Cesium.Color.TRANSPARENT;
        if (dataSource === 'osm-buildings') {
          // OSM massing context: keep the globe with the satellite base map —
          // the extruded buildings sit ON TOP of the imagery, and the globe
          // is what receives their cast shadows during a sun study.
          scene.globe.show = true;
          scene.globe.shadows = Cesium.ShadowMode.RECEIVE_ONLY;
          try {
            const imagery = await Cesium.createWorldImageryAsync();
            if (!cancelled) viewer.imageryLayers.addImageryProvider(imagery);
          } catch { /* imagery unavailable — buildings still render */ }
        } else {
          // Photorealistic tiles bring their own ground; the globe would
          // z-fight underneath them.
          scene.globe.show = false;
        }
        if (cancelled) { viewer.destroy(); return; }

        // Add terrain
        if (terrainEnabled && ionToken) {
          try {
            const terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
            viewer.terrainProvider = terrainProvider;
          } catch { /* terrain unavailable */ }
        }

        // Add data source layer
        tilesetRef.current = await addDataSourceLayer(Cesium, viewer, dataSource, ionToken);

        if (cancelled) { viewer.destroy(); return; }

        viewerRef.current = viewer;
        setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          console.error('[CesiumOverlay] Init failed:', err);
          setError(err instanceof Error ? err.message : 'Cesium initialization failed');
          setStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      // Invalidate model ref — the destroyed viewer took the primitive with it,
      // so Effect 2c must re-load the GLB into the next viewer instance.
      cesiumModelRef.current = null;
      bridgeRef.current = null;
      // The destroyed viewer also took the tileset + sun-path entities.
      tilesetRef.current = null;
      sunPathDomeRef.current = null;
      sunPathDomeDayRef.current = null;
      solarTouchedSceneRef.current = false;
      setStatus('idle');
    };
  }, [cesiumEnabled, ionToken, terrainEnabled, dataSource]);

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
      const Cesium = cesiumModule;
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

  // ─── Effect 2c: Load GLB into Cesium (only when geometry changes) ───────
  // This is the heavy operation — only re-runs when geometry actually changes.
  useEffect(() => {
    if (status !== 'ready' || !geometryResult?.meshes?.length) return;
    const viewer = viewerRef.current;
    const bridge = bridgeRef.current;
    const Cesium = cesiumModule;
    if (!viewer || !bridge || !Cesium) return;

    let cancelled = false;

    const startExport = async () => {
      if (cancelled) return;
      try {
        // Export GLB (cached by mesh count — skip if already loaded)
        const meshCount = geometryResult.meshes.length;
        if (cesiumModelRef.current && glbCacheRef.current?.meshCount === meshCount) {
          // Model already loaded with same geometry — just update matrix
          return;
        }

        // Remove previous model
        if (cesiumModelRef.current) {
          viewer.scene.primitives.remove(cesiumModelRef.current);
          cesiumModelRef.current = null;
        }

        let glbBytes: Uint8Array;
        if (glbCacheRef.current?.meshCount === meshCount) {
          glbBytes = glbCacheRef.current.glb;
        } else {
          await new Promise(r => setTimeout(r, 50));
          if (cancelled) return;
          glbBytes = buildMergedGLB(geometryResult.meshes);
          glbCacheRef.current = { meshCount, glb: glbBytes };
        }
        if (cancelled) return;

        await new Promise(r => setTimeout(r, 0));
        if (cancelled) return;

        // Build initial model matrix
        const modelMatrix = buildModelMatrix(Cesium, bridge, coordinateInfo);

        const blob = new Blob([glbBytes as BlobPart], { type: 'model/gltf-binary' });
        const glbUrl = URL.createObjectURL(blob);
        let model: { modelMatrix: any; destroy?: () => void } | null = null;
        try {
          model = await Cesium.Model.fromGltfAsync({
            url: glbUrl,
            modelMatrix,
            shadows: Cesium.ShadowMode.DISABLED,
            // The generated GLB stores viewer-space vertices and buildModelMatrix
            // already maps viewer axes into ENU. Avoid Cesium's default glTF
            // Y-up/Z-forward correction or the model is rotated onto its side.
            upAxis: Cesium.Axis.Z,
            forwardAxis: Cesium.Axis.X,
          });
          // Ambient floor. The overlay composits transparently with the
          // atmosphere/skybox off, so the scene's ONLY light is the directional
          // sun — without an environment map the model's shadowed faces get no
          // ambient and read muddy. Give the model a flat image-based-lighting
          // ambient via a constant spherical-harmonic term: every surface stays
          // readable while the sun still shapes the lit faces. (#1380)
          try {
            const ibl = (model as unknown as {
              imageBasedLighting?: { sphericalHarmonicCoefficients: unknown };
            }).imageBasedLighting;
            if (ibl) {
              const a = new Cesium.Cartesian3(0.72, 0.72, 0.75); // neutral daylight ambient
              const z = Cesium.Cartesian3.ZERO;
              ibl.sphericalHarmonicCoefficients = [a, z, z, z, z, z, z, z, z];
            }
          } catch (e) {
            console.warn('[CesiumOverlay] could not set model ambient IBL:', e);
          }
        } finally {
          URL.revokeObjectURL(glbUrl);
        }
        if (cancelled) {
          model?.destroy?.();
          return;
        }

        viewer.scene.primitives.add(model);
        cesiumModelRef.current = model;
        setCesiumGlbLoaded(true);
        viewer.scene.requestRender();
      } catch (err) {
        console.warn('[CesiumOverlay] Failed to load IFC model into Cesium:', err);
      }
    };

    const deferTimer = setTimeout(startExport, 1000);

    return () => {
      cancelled = true;
      clearTimeout(deferTimer);
      if (cesiumModelRef.current && viewerRef.current) {
        viewerRef.current.scene.primitives.remove(cesiumModelRef.current);
        cesiumModelRef.current = null;
      }
      setCesiumGlbLoaded(false);
    };
  }, [status, bridgeVersion, geometryResult]);

  // ─── Effect 2d: Update model matrix (instant, no reload) ────────────────
  // When terrain placement or georef changes, just update the
  // existing model's matrix — no GLB re-export, no flicker.
  useEffect(() => {
    const model = cesiumModelRef.current;
    const bridge = bridgeRef.current;
    const viewer = viewerRef.current;
    const Cesium = cesiumModule;
    if (!model || !bridge || !viewer || !Cesium) return;

    const newMatrix = buildModelMatrix(Cesium, bridge, coordinateInfo);
    model.modelMatrix = newMatrix;
    viewer.scene.requestRender();
    // Depend on bridgeVersion so the matrix is rebuilt with the *new* bridge
    // after async createCesiumBridge replaces it. Placement is baked into
    // bridge.modelOrigin.height by Effect 2.
  }, [mapConversion, projectedCRS, coordinateInfo, lengthUnitScale, bridgeVersion]);

  // ─── Effect 4: Solar study — sun-path dome + shadows ────────────────────
  // Drives Cesium's sun/lighting/shadow map from the studied instant, builds
  // (and live-updates) the 3D sun-path dome anchored at the model origin, and
  // publishes the resolved sun position/times back to the store for the panel.
  useEffect(() => {
    const viewer = viewerRef.current;
    const bridge = bridgeRef.current;
    const Cesium = cesiumModule;
    if (status !== 'ready' || !viewer || !bridge || !Cesium) return;

    // Never mutate the default Cesium lighting until the study is first
    // enabled — a plain georeferenced model shouldn't have its context
    // re-lit just because this effect mounts with solar off.
    if (!solarEnabled && !solarTouchedSceneRef.current) return;
    solarTouchedSceneRef.current = true;

    const date = new Date(solarDateMs);
    const { latitude, longitude, height } = bridge.modelOrigin;

    // Cast/receive shadows on the IFC model and the context tileset.
    const shadowMode = solarEnabled && solarShowShadows
      ? Cesium.ShadowMode.ENABLED
      : Cesium.ShadowMode.DISABLED;
    if (cesiumModelRef.current) cesiumModelRef.current.shadows = shadowMode;
    if (tilesetRef.current) tilesetRef.current.shadows = shadowMode;

    applySolarScene(Cesium, viewer, {
      date,
      enabled: solarEnabled,
      shadows: solarShowShadows,
      showSun: envSkyEnabled,
    });

    if (solarEnabled) {
      // Publish the readout for the panel.
      const times = sunTimes(date, latitude, longitude);
      const sp = sunPosition(date, latitude, longitude);
      setSolarSunInfo({
        latitude,
        longitude,
        azimuth: sp.azimuth,
        altitude: sp.altitude,
        sunriseMs: times.sunrise ? times.sunrise.getTime() : null,
        sunsetMs: times.sunset ? times.sunset.getTime() : null,
        solarNoonMs: times.solarNoon.getTime(),
      });

      if (solarShowSunPath) {
        const dayKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
        try {
          if (!sunPathDomeRef.current || sunPathDomeDayRef.current !== dayKey) {
            // New day or site → rebuild static geometry (day arc + analemmas).
            sunPathDomeRef.current?.destroy();
            const bounds = coordinateInfo?.originalBounds;
            // Size the dome to roughly the model footprint, but clamp to an
            // architectural scale: with many federated models the combined
            // bounds can span kilometres, which would push the dome arcs so
            // far out they read as nothing. Half-diagonal ≈ bounding radius.
            const rawRadius = bounds
              ? 0.5 * Math.hypot(
                  bounds.max.x - bounds.min.x,
                  bounds.max.y - bounds.min.y,
                  bounds.max.z - bounds.min.z,
                )
              : 80;
            const radius = Math.min(250, Math.max(40, rawRadius));
            sunPathDomeRef.current = new SunPathDome(Cesium, viewer, {
              origin: { latitude, longitude, height },
              radius,
              date,
              showAnalemmas: true,
            });
            sunPathDomeDayRef.current = dayKey;
          } else {
            // Same day, new time → just move the sun marker + beam.
            sunPathDomeRef.current.update(date);
          }
        } catch (err) {
          console.warn('[CesiumOverlay] sun-path dome build/update failed:', err);
        }
      } else if (sunPathDomeRef.current) {
        sunPathDomeRef.current.destroy();
        sunPathDomeRef.current = null;
        sunPathDomeDayRef.current = null;
      }
    } else if (sunPathDomeRef.current) {
      sunPathDomeRef.current.destroy();
      sunPathDomeRef.current = null;
      sunPathDomeDayRef.current = null;
    }

    viewer.scene.requestRender();
  }, [
    status,
    bridgeVersion,
    cesiumGlbLoaded,
    solarEnabled,
    solarDateMs,
    solarShowSunPath,
    solarShowShadows,
    envSkyEnabled,
    coordinateInfo,
    setSolarSunInfo,
  ]);

  // ─── Effect 4b: Sky — atmosphere + sun + fog ────────────────────────────
  // The environment panel's Sky toggle. Init disables all of these for
  // transparent compositing; this effect re-enables them on demand. The
  // area outside the atmosphere stays transparent (skyBox off), so space
  // composites over the app background like the rest of the overlay.
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumModule;
    if (status !== 'ready' || !viewer || !Cesium) return;
    const scene = viewer.scene;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = envSkyEnabled;
    scene.fog.enabled = envSkyEnabled;
    // Haze on the satellite base map (no-op while the globe is hidden).
    scene.globe.showGroundAtmosphere = envSkyEnabled && scene.globe.show;
    // Sun billboard only when the solar effect isn't already managing it
    // (applySolarScene runs with showSun and wins on solar state changes).
    if (scene.sun && !solarTouchedSceneRef.current) {
      scene.sun.show = envSkyEnabled;
    }
    scene.requestRender();
  }, [status, envSkyEnabled]);

  // ─── Effect 3: Camera sync loop ─────────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready') return;

    const viewer = viewerRef.current;
    if (!viewer) return;

    let cancelled = false;

    function syncCamera() {
      if (cancelled) return;

      const bridge = bridgeRef.current;
      const cameraBridge = cameraBridgeRef.current ?? bridge;
      const renderer = getGlobalRenderer();
      const Cesium = cesiumModule;
      if (!viewer || !bridge || !cameraBridge || !renderer || !Cesium) {
        rafRef.current = requestAnimationFrame(syncCamera);
        return;
      }

      const camera = renderer.getCamera();
      let camPos = camera.getPosition();
      let camTarget = camera.getTarget();
      const camUp = camera.getUp();
      const fov = camera.getFOV();

      if (terrainClipY !== null) {
        const minCameraY = terrainClipY + 0.05;
        if (camPos.y < minCameraY) {
          const dy = minCameraY - camPos.y;
          camPos = { ...camPos, y: minCameraY };
          camTarget = { ...camTarget, y: camTarget.y + dy };
        }
      }

      // bridge.modelOrigin.height already has the placement baked in, so the
      // camera frame and the model matrix share the same enuToEcef origin altitude.
      cameraBridge.syncCamera(Cesium, viewer, camPos, camTarget, camUp, fov);

      rafRef.current = requestAnimationFrame(syncCamera);
    }

    rafRef.current = requestAnimationFrame(syncCamera);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [status, terrainClipY]);

  if (!cesiumEnabled || !mapConversion || !projectedCRS) {
    return null;
  }

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 z-0"
        style={{ pointerEvents: 'none' }}
      />
      {status === 'loading' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-3 py-1.5 bg-black/60 backdrop-blur-sm rounded text-xs text-white font-mono">
          <div className="h-3 w-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          Loading 3D context...
        </div>
      )}
      {status === 'error' && error && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 bg-red-900/80 backdrop-blur-sm rounded text-xs text-red-200 font-mono">
          {error}
        </div>
      )}
    </>
  );
}

/**
 * Add the selected 3D context layer to the Cesium viewer. Returns the created
 * tileset so callers can toggle its shadow casting/receiving for solar
 * studies (`null` if none could be created).
 */
async function addDataSourceLayer(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  dataSource: string,
  ionToken: string,
): Promise<InstanceType<typeof import('cesium').Cesium3DTileset> | null> {
  try {
    switch (dataSource) {
      case 'osm-buildings': {
        // OpenStreetMap Buildings — flat-shaded extruded footprints, the grey
        // massing context used for sun-path / overshadowing studies.
        const tileset = await Cesium.createOsmBuildingsAsync();
        viewer.scene.primitives.add(tileset);
        return tileset;
      }
      case 'google-photorealistic':
      default: {
        try {
          const tileset = await Cesium.createGooglePhotorealistic3DTileset();
          viewer.scene.primitives.add(tileset);
          return tileset;
        } catch {
          if (ionToken) {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(2275207);
            viewer.scene.primitives.add(tileset);
            return tileset;
          }
          return null;
        }
      }
    }
  } catch (err) {
    console.warn('[CesiumOverlay] Failed to add data source:', dataSource, err);
    return null;
  }
}
