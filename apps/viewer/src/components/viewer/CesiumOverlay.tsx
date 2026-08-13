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
import { applySolarScene, SunPathDome } from '@/lib/geo/cesium-sun';
import { sunPosition, sunTimes } from '@ifc-lite/solar';
import { loadCesium, getCesiumModule } from './cesium/cesium-module';
import { useCesiumBridge } from './cesium/useCesiumBridge';
import { useCesiumModel } from './cesium/useCesiumModel';
import { useCesiumSolar } from './cesium/useCesiumSolar';
import { useCesiumCameraSync } from './cesium/useCesiumCameraSync';



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
  /** Storey isolation, class filter and manual isolation already intersected,
   *  exactly as the viewport receives it. The world view must hide what the
   *  viewport hides (#2578). */
  computedIsolatedIds?: ReadonlySet<number> | null;
}

export function CesiumOverlay({
  mapConversion,
  cameraMapConversion,
  projectedCRS,
  coordinateInfo,
  geometryResult,
  lengthUnitScale = 1,
  storeyElevations,
  computedIsolatedIds,
}: CesiumOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<typeof import('cesium').Viewer> | null>(null);
  const bridgeRef = useRef<CesiumBridge | null>(null);
  const cameraBridgeRef = useRef<CesiumBridge | null>(null);
  const rafRef = useRef<number | null>(null);
  // Bridges the model hook's teardown back to the viewer effect, which is
  // DECLARED FIRST and so cannot call the hook's return value directly. Read
  // only from that effect's cleanup, long after the assignment below.
  const invalidateModelRef = useRef<() => void>(() => {});
  const invalidateSolarRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Tracks bridge readiness as state (not just a ref) so terrain query effect re-runs
  // Bumped every time a NEW model primitive reaches the globe. `cesiumGlbLoaded`
  // used to serve this purpose by flipping false→true around every rebuild, but
  // the model now stays loaded across one (#2583), so the flag no longer moves.

  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const ionToken = useViewerStore((s) => s.cesiumIonToken);
  const terrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const terrainClipY = useViewerStore((s) => s.cesiumTerrainClipY);
  // In-place mesh mutations (a gizmo move rewrites positions in the SAME
  // arrays) change no mesh count, so the world-view GLB cache keys on this too.
  // Hide/isolate, resolved the way Viewport resolves what it hands the
  // renderer, so the map draws the elements the viewport draws (#2578).
  // The GLB effect keys on this version, NOT on the Set references. The store
  // hands out a fresh Set on every visibility action, and the effect's cleanup
  // pulls the model off the globe — so keying on identity blanks the map for a
  // second and rebuilds a multi-megabyte GLB even when the content is
  // unchanged. `VisibilityEpochTracker` compares content, so an equal set is a
  // no-op while an in-place mutation of the same Set still registers.
  //
  // Safe to run during render: `update()` only bumps when the content actually
  // changed, so a double-invoked render (StrictMode) returns the same version.
  // Read inside the deferred build, which runs long after the effect fired.

  // Solar study state — drives the sun-path dome + shadow study.
  // Environment sky toggle — atmosphere + sun + fog in geo mode.

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  // Key of the model actually ON the globe, which is not the same thing as the
  // key of the last GLB built — see the gate in Effect 2c.
  // Active 3D context tileset (Google Photorealistic / OSM buildings) — kept so
  // solar mode can toggle its shadow casting/receiving.
  const tilesetRef = useRef<{ shadows?: any } | null>(null);
  // Active sun-path dome entity collection (null when solar study is off).
  // UTC calendar day the dome's static geometry (day-arc, analemmas) was built
  // for. Intra-day time scrubs only move the sun marker; a new day rebuilds.
  // Whether the solar study has ever touched Cesium scene state. Guards us
  // from mutating the default (non-solar) lighting on plain mount.


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
        if (scene.skyBox) scene.skyBox.show = false;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
        scene.fog.enabled = false;
        scene.globe.showGroundAtmosphere = false;
        scene.backgroundColor = Cesium.Color.TRANSPARENT;
        scene.globe.baseColor = Cesium.Color.TRANSPARENT;
        if (dataSource === 'osm-map') {
          // Plain OpenStreetMap slippy map: a simple, uncluttered flat base
          // map (no satellite imagery, no 3D massing) for users who find the
          // photorealistic globe overwhelming (#1744). The globe drapes the
          // OSM tiles (over terrain when enabled) and receives cast shadows.
          scene.globe.show = true;
          scene.globe.shadows = Cesium.ShadowMode.RECEIVE_ONLY;
          try {
            // maximumLevel 19 = OSM's deepest tile zoom; conforms to the
            // OpenStreetMap tile usage policy and avoids 404s past z19.
            // Pass an explicit `credit`: Cesium's default OSM credit is the
            // outdated "MapQuest … CC-BY-SA" string, but the OSMF tile policy
            // requires a visible "© OpenStreetMap contributors" attribution
            // linking to the copyright page. Cesium renders credit HTML, so the
            // anchor is clickable in the on-canvas attribution.
            const osm = new Cesium.OpenStreetMapImageryProvider({
              maximumLevel: 19,
              credit:
                '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
            });
            if (!cancelled) viewer.imageryLayers.addImageryProvider(osm);
          } catch (e) { console.warn('[CesiumOverlay] OSM base map unavailable:', e); }
        } else if (dataSource === 'osm-buildings') {
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
      // so Effect 2c must re-load the GLB into the next viewer instance. The
      // store flag has to follow, or it advertises a model that is gone.
      invalidateModelRef.current();
      bridgeRef.current = null;
      // The destroyed viewer also took the tileset + sun-path entities.
      tilesetRef.current = null;
      invalidateSolarRef.current();
      setStatus('idle');
    };
  }, [cesiumEnabled, ionToken, terrainEnabled, dataSource]);

  // ─── Coordinate bridge: georeference to a place on the globe ────────────
  // After the viewer effect (it needs a live viewer for terrain sampling) and
  // before the model hook, which rebuilds its matrix from `bridgeVersion`.
  const { bridgeVersion } = useCesiumBridge({
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
  });

  // ─── Model lifecycle: build, load, swap, keep the matrix current ────────
  // Called HERE, between the bridge effect and the solar effect, because React
  // runs effects in declaration order and cleanups in reverse — the teardown
  // inside this hook assumes the viewer effect's cleanup runs after its own.
  const { modelRef: cesiumModelRef, modelEpoch: cesiumModelEpoch, invalidate: invalidateModel } = useCesiumModel({
    status,
    bridgeVersion,
    viewerRef,
    bridgeRef,
    geometryResult,
    coordinateInfo,
    mapConversion,
    projectedCRS,
    lengthUnitScale,
    computedIsolatedIds,
  });
  invalidateModelRef.current = invalidateModel;

  // ─── Solar study: lighting, shadows, sun-path dome, sky ─────────────────
  // Declared AFTER the model hook: it applies shadow settings to the primitive
  // that hook owns, and keys on its epoch so a swapped-in model gets them.
  const { invalidate: invalidateSolar } = useCesiumSolar({
    status,
    bridgeVersion,
    viewerRef,
    bridgeRef,
    modelRef: cesiumModelRef,
    modelEpoch: cesiumModelEpoch,
    tilesetRef,
    coordinateInfo,
  });
  invalidateSolarRef.current = invalidateSolar;

  // ─── Camera sync: mirror the viewport's pose onto the globe, per frame ──
  useCesiumCameraSync({ status, viewerRef, bridgeRef, cameraBridgeRef, terrainClipY, rafRef });


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
      case 'osm-map': {
        // Plain OSM base map: the imagery layer is the whole context (added in
        // Effect 1). There is no 3D tileset to place — return null so solar
        // shadows fall on the globe alone.
        return null;
      }
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
