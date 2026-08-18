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
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { attachTileSuccessRetraction, classifyTileProviderError, toUrlTemplateProviderOptions } from '@/lib/geo/custom-basemap';
import { loadCesium } from './cesium/cesium-module';
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
  /**
   * Non-fatal basemap trouble — a custom tile server the browser is not allowed
   * to read (#2685). Deliberately NOT `status: 'error'`: the overlay is
   * otherwise working (model, terrain, camera sync all live) and the hooks below
   * key off `status`, so failing the whole overlay over imagery would tear down
   * a working world context.
   */
  const [basemapWarning, setBasemapWarning] = useState<string | null>(null);

  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const storedCustomBasemap = useViewerStore((s) => s.cesiumCustomBasemap);
  // Null unless the custom source is actually selected, so editing the tile URL
  // while another basemap is showing does not tear down and rebuild the viewer.
  const customBasemap = dataSource === 'custom' ? storedCustomBasemap : null;
  const ionToken = useViewerStore((s) => s.cesiumIonToken);
  const terrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const terrainClipY = useViewerStore((s) => s.cesiumTerrainClipY);

  // Active 3D context tileset (Google Photorealistic / OSM buildings) — kept so
  // solar mode can toggle its shadow casting/receiving.
  const tilesetRef = useRef<{ shadows?: any } | null>(null);

  // ─── Effect 1: Create/destroy the Cesium viewer (heavy, rare) ───────────
  // Only depends on cesiumEnabled, ionToken, terrainEnabled, dataSource.
  // NOT on mapConversion/projectedCRS — those are handled by Effect 2.
  useEffect(() => {
    if (!cesiumEnabled || !containerRef.current) return;

    let cancelled = false;
    // Cesium's `addEventListener` returns its own remover; hold it so the
    // cleanup can detach the basemap error listener with the effect.
    let removeBasemapErrorListener: (() => void) | null = null;
    setStatus('loading');
    setError(null);
    setBasemapWarning(null);

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
        } else if (dataSource === 'custom') {
          // User-supplied XYZ tile template (#2685). Same globe treatment as
          // the OSM map: the imagery IS the context, draped over terrain.
          scene.globe.show = true;
          scene.globe.shadows = Cesium.ShadowMode.RECEIVE_ONLY;
          if (!customBasemap) {
            // Reachable only if the picker and the stored basemap disagree; the
            // globe would otherwise come up blank with no explanation.
            setBasemapWarning('No custom basemap is configured. Add a tile URL in Sun & Sky > Base map.');
          } else {
            try {
              const provider = new Cesium.UrlTemplateImageryProvider(
                toUrlTemplateProviderOptions(customBasemap),
              );
              // The failure this catches is the one that otherwise looks like
              // nothing: a server without `Access-Control-Allow-Origin` never
              // produces a response, so Cesium reports a RequestErrorEvent with
              // no `statusCode` and the globe just stays empty. Cesium retries
              // and re-raises per tile, so the listener fires repeatedly —
              // setting the same string is a no-op for React.
              //
              // `!cancelled` for the same reason the `addImageryProvider` line
              // below has it. Cesium frees a tile's texture on teardown but
              // never cancels the in-flight request, and `viewer.destroy()`
              // does not clear this listener array — so a provider belonging to
              // an already-destroyed viewer can still raise, and warn about a
              // basemap the user has since switched away from. Pick Custom with
              // a slow host, switch to OSM Map inside the connect timeout, and
              // BROWSER_ACCESS_BLOCKED lands on top of a working OSM globe.
              //
              // The unsubscribe Cesium returns is kept rather than discarded,
              // so the listener's lifetime is the EFFECT's rather than the
              // provider's — the flag alone would leave a dead listener holding
              // this closure for as long as the provider lives.
              removeBasemapErrorListener = provider.errorEvent.addEventListener(
                (event: unknown) => {
                  const message = classifyTileProviderError(event);
                  if (message && !cancelled) setBasemapWarning(message);
                },
              );
              // …and this is how it goes away again: a single transient failure
              // must not leave the banner up forever over a working basemap.
              //
              // Guarded too, and this one matters more than the listener,
              // because it RETRACTS. Switch away from a slow custom basemap to
              // a different one that genuinely is CORS-blocked, and a late tile
              // from the destroyed provider would clear the new basemap's
              // legitimate warning — leaving a blank globe with nothing on
              // screen, the exact failure this feature exists to eliminate.
              // The wrapper is left on the dead provider; only its effect on
              // this component's state is cut, which is all that outlives the
              // provider anyway.
              attachTileSuccessRetraction(provider, (update) => {
                if (!cancelled) setBasemapWarning(update);
              });
              if (!cancelled) viewer.imageryLayers.addImageryProvider(provider);
            } catch (e) {
              console.warn('[CesiumOverlay] Custom basemap unavailable:', e);
              // Same effect, same hole: the constructor can throw after a
              // teardown that already cleared the banner.
              if (!cancelled) setBasemapWarning('That tile URL could not be used as a basemap.');
            }
          }
        } else if (dataSource === 'osm-buildings') {
          // OSM massing context: keep the globe with the satellite base map —
          // the extruded buildings sit ON TOP of the imagery, and the globe
          // is what receives their cast shadows during a sun study.
          scene.globe.show = true;
          scene.globe.shadows = Cesium.ShadowMode.RECEIVE_ONLY;
          try {
            const imagery = await Cesium.createWorldImageryAsync();
            if (!cancelled) viewer.imageryLayers.addImageryProvider(imagery);
          } catch { /* imagery unavailable: buildings still render */ }
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
      removeBasemapErrorListener?.();
      removeBasemapErrorListener = null;
      setStatus('idle');
      setBasemapWarning(null);
    };
  }, [cesiumEnabled, ionToken, terrainEnabled, dataSource, customBasemap]);

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
  // Called HERE, between the bridge and the solar study, because React runs a
  // component's effects — setups AND cleanups — in declaration order. Each
  // hook's header states what that buys it; moving a call changes teardown
  // order as much as setup order.
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
      {/*
        One stack, not three absolutely positioned siblings at the same offset.
        The basemap warning is raised from inside the init routine, since the
        custom branch runs before `setStatus('ready')`, so it and the loading banner
        are both on screen for exactly the case that most needs reading, a slow
        or refused tile host, and at `top-2 left-1/2` they landed on top of each
        other. Stacked, each banner keeps its own colour and the order is
        status-then-warning.
      */}
      {(status === 'loading' || (status === 'error' && error) || basemapWarning) && (
      <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
        {status === 'loading' && (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-black/60 backdrop-blur-sm rounded text-xs text-white font-mono">
            <div className="h-3 w-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Loading 3D context...
          </div>
        )}
        {status === 'error' && error && (
          <div className="px-3 py-1.5 bg-red-900/80 backdrop-blur-sm rounded text-xs text-red-200 font-mono">
            {error}
          </div>
        )}
        {basemapWarning && (
          <div
            role="status"
            className="max-w-md px-3 py-1.5 bg-amber-900/80 backdrop-blur-sm rounded text-xs text-amber-100"
          >
            {basemapWarning}
          </div>
        )}
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
      case 'osm-map':
      case 'custom': {
        // Flat imagery bases: the imagery layer is the whole context (added in
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
