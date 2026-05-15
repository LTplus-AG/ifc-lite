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
} from '@/lib/geo/cesium-placement';
import { getEffectiveHorizontalScale } from '@/lib/geo/geo-scale';

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
 * Build a minimal GLB with all geometry merged into a SINGLE mesh.
 * This is MUCH faster than GLTFExporter (which creates one glTF node per IFC mesh).
 * For a 42K mesh model: GLTFExporter takes seconds, this takes ~100ms.
 */
function buildMergedGLB(meshes: import('@ifc-lite/geometry').MeshData[]): Uint8Array {
  // Pass 1: calculate total sizes
  let totalVerts = 0;
  let totalIdxs = 0;
  for (const m of meshes) {
    if (!m.positions?.length || !m.indices?.length) continue;
    totalVerts += m.positions.length / 3;
    totalIdxs += m.indices.length;
  }

  // Allocate merged buffers
  const positions = new Float32Array(totalVerts * 3);
  const colors = new Uint8Array(totalVerts * 4);
  const indices = new Uint32Array(totalIdxs);

  // Pass 2: merge
  let vertOff = 0;
  let idxOff = 0;
  for (const m of meshes) {
    if (!m.positions?.length || !m.indices?.length) continue;
    const nv = m.positions.length / 3;
    positions.set(m.positions, vertOff * 3);
    // Vertex colors from mesh color
    const r = Math.round((m.color?.[0] ?? 0.7) * 255);
    const g = Math.round((m.color?.[1] ?? 0.7) * 255);
    const b = Math.round((m.color?.[2] ?? 0.7) * 255);
    const a = Math.round((m.color?.[3] ?? 1.0) * 255);
    for (let i = 0; i < nv; i++) {
      const ci = (vertOff + i) * 4;
      colors[ci] = r; colors[ci + 1] = g; colors[ci + 2] = b; colors[ci + 3] = a;
    }
    for (let i = 0; i < m.indices.length; i++) {
      indices[idxOff + i] = m.indices[i] + vertOff;
    }
    vertOff += nv;
    idxOff += m.indices.length;
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Build minimal glTF JSON
  const posByteLen = positions.byteLength;
  const colByteLen = colors.byteLength;
  const idxByteLen = indices.byteLength;
  const totalBinLen = posByteLen + colByteLen + idxByteLen;

  const gltf = {
    asset: { version: '2.0', generator: 'IFC-Lite-Cesium' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: totalVerts, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      { bufferView: 1, componentType: 5121, count: totalVerts, type: 'VEC4', normalized: true },
      { bufferView: 2, componentType: 5125, count: totalIdxs, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posByteLen, target: 34962 },
      { buffer: 0, byteOffset: posByteLen, byteLength: colByteLen, target: 34962 },
      { buffer: 0, byteOffset: posByteLen + colByteLen, byteLength: idxByteLen, target: 34963 },
    ],
    buffers: [{ byteLength: totalBinLen }],
    extensionsUsed: ['KHR_materials_unlit'],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = new TextEncoder().encode(jsonStr);
  // Pad JSON to 4-byte alignment
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  // Pad binary to 4-byte alignment
  const binPad = (4 - (totalBinLen % 4)) % 4;
  const binChunkLen = totalBinLen + binPad;

  // GLB: 12-byte header + 8-byte JSON chunk header + JSON + 8-byte BIN chunk header + BIN
  const glbLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const glb = new ArrayBuffer(glbLen);
  const view = new DataView(glb);
  let off = 0;

  // GLB header
  view.setUint32(off, 0x46546C67, true); off += 4; // magic "glTF"
  view.setUint32(off, 2, true); off += 4;           // version
  view.setUint32(off, glbLen, true); off += 4;       // total length

  // JSON chunk
  view.setUint32(off, jsonChunkLen, true); off += 4;
  view.setUint32(off, 0x4E4F534A, true); off += 4;   // "JSON"
  new Uint8Array(glb, off, jsonBuf.length).set(jsonBuf); off += jsonBuf.length;
  for (let i = 0; i < jsonPad; i++) view.setUint8(off++, 0x20); // space padding

  // BIN chunk
  view.setUint32(off, binChunkLen, true); off += 4;
  view.setUint32(off, 0x004E4942, true); off += 4;   // "BIN\0"
  new Uint8Array(glb, off, posByteLen).set(new Uint8Array(positions.buffer)); off += posByteLen;
  new Uint8Array(glb, off, colByteLen).set(colors); off += colByteLen;
  new Uint8Array(glb, off, idxByteLen).set(new Uint8Array(indices.buffer)); off += idxByteLen;

  return new Uint8Array(glb);
}

/**
 * Build a Cesium model matrix for placing the IFC model in ECEF.
 * Extracted as a pure function so it can be called from both
 * the GLB load effect (initial) and the matrix update effect (instant).
 */
function buildModelMatrix(
  Cesium: typeof import('cesium'),
  bridge: CesiumBridge,
  mapConversion: MapConversion | undefined,
  projectedCRS: ProjectedCRS | undefined,
  coordinateInfo: CoordinateInfo | undefined,
  lengthUnitScale: number,
) {
  // GLB vertices are in viewer-space metres (geometry engine converts during
  // extraction). IfcMapConversion.Scale is defined per IFC spec relative to
  // the project length unit, so applying it raw to metre-converted geometry
  // double-scales the model — see issue #595. Use the effective scale.
  const mapUnitScale = projectedCRS?.mapUnitScale ?? lengthUnitScale;
  const hScale = getEffectiveHorizontalScale(mapConversion?.scale, mapUnitScale, lengthUnitScale);
  const absc = mapConversion?.xAxisAbscissa ?? 1.0;
  const ordi = mapConversion?.xAxisOrdinate ?? 0.0;
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
  // No lengthUnitScale here — viewer-space GLB vertices are already in metres.
  const sa = hScale * absc, so = hScale * ordi;
  const tx = -(sa * mvx + so * mvz);
  const ty = -(so * mvx - sa * mvz);
  const tz = -mvy;
  const ifcToEnu = new Cesium.Matrix4(
    sa, 0,  so, tx,
    so, 0, -sa, ty,
    0,  1,  0,  tz,
    0,  0,  0,  1,
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
  const terrainClipY = useViewerStore((s) => s.cesiumTerrainClipY);
  const setCesiumTerrainHeight = useViewerStore((s) => s.setCesiumTerrainHeight);
  const setCesiumTerrainSource = useViewerStore((s) => s.setCesiumTerrainSource);
  const setCesiumTerrainClipY = useViewerStore((s) => s.setCesiumTerrainClipY);
  const setCesiumGlbLoaded = useViewerStore((s) => s.setCesiumGlbLoaded);

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  const cesiumModelRef = useRef<{ modelMatrix: any; destroy?: () => void } | null>(null);
  const glbCacheRef = useRef<{ meshCount: number; glb: Uint8Array } | null>(null);

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

        // Disable skybox/atmosphere/fog for transparent compositing
        if (scene.skyBox) (scene.skyBox as any).show = false;
        if (scene.sun) scene.sun.show = false;
        if (scene.moon) scene.moon.show = false;
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
        scene.fog.enabled = false;
        scene.globe.showGroundAtmosphere = false;
        scene.backgroundColor = Cesium.Color.TRANSPARENT;
        scene.globe.baseColor = Cesium.Color.TRANSPARENT;
        scene.globe.show = false;

        // Add terrain
        if (terrainEnabled && ionToken) {
          try {
            const terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
            viewer.terrainProvider = terrainProvider;
          } catch { /* terrain unavailable */ }
        }

        // Add data source layer
        await addDataSourceLayer(Cesium, viewer, dataSource, ionToken);

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
      const t0 = performance.now();
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
      const terrainMs = performance.now() - t0;
      const terrainH = terrainSample?.height ?? null;
      const modelTentative = usesSeparateCameraBridge
        ? await createCesiumBridge(mapConversion, projectedCRS, coordinateInfo, lengthUnitScale)
        : cameraTentative;
      if (cancelled) return;
      if (!modelTentative) {
        bridgeRef.current = null;
        return;
      }
      let placement = computeCesiumPlacement({
        coordinateInfo,
        projectedCRS,
        ifcOriginHeight: modelTentative.modelOrigin.height,
        terrainHeight: terrainH,
        storeyElevations,
      });
      const cameraPlacement = usesSeparateCameraBridge
        ? computeCesiumPlacement({
            coordinateInfo,
            projectedCRS,
            ifcOriginHeight: cameraTentative.modelOrigin.height,
            terrainHeight: terrainH,
            storeyElevations,
          })
        : placement;
      if (usesSeparateCameraBridge) {
        const mapScale = projectedCRS.mapUnitScale ?? lengthUnitScale;
        const deltaHeightMeters = (
          mapConversion.orthogonalHeight - cameraConversion.orthogonalHeight
        ) * mapScale;
        const floorPlacementHeight = terrainH !== null
          ? terrainH + cameraPlacement.anchorOffset
          : Number.NEGATIVE_INFINITY;
        placement = {
          ...placement,
          placementHeight: Math.max(
            cameraPlacement.placementHeight + deltaHeightMeters,
            floorPlacementHeight,
          ),
        };
      }

      console.debug(
        `[CesiumOverlay] placement decision: terrain=${terrainH?.toFixed(2) ?? 'null'}m`
        + ` source=${terrainSample?.source ?? 'none'}`
        + ` ref=${terrainSample?.reference ?? 'none'}`
        + ` ifcOHeight=${placement.ifcOriginHeight.toFixed(2)}m`
        + ` anchorY=${placement.clampAnchorY.toFixed(2)}m`
        + ` (minY=${placement.minY.toFixed(2)}m, ${storeyElevations?.size ?? 0} storeys)`
        + ` placement=${placement.placementHeight.toFixed(2)}m`
        + ` (terrain query: ${terrainMs.toFixed(0)}ms)`
      );

      // Build the final bridge with the placement baked in (or reuse the
      // tentative one when the placement matches its IFC-derived origin).
      let bridge = modelTentative;
      if (Math.abs(placement.placementHeight - placement.ifcOriginHeight) > 1e-6) {
        const final = await createCesiumBridge(
          mapConversion, projectedCRS, coordinateInfo, lengthUnitScale,
          placement.placementHeight,
        );
        if (cancelled) return;
        if (!final) {
          bridgeRef.current = null;
          return;
        }
        bridge = final;
      }

      if (terrainSample) {
        setCesiumTerrainHeight(terrainH);
        setCesiumTerrainSource(
          `${terrainSample.source}${terrainSample.reference === 'orthometric' ? ' (orthometric)' : ''}`,
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
            console.debug(
              `[CesiumOverlay] placement Δh=${dh.toFixed(2)}m → shifted IFC camera Y by ${(-dh).toFixed(2)}m to hold world camera`,
            );
          }
        }
      }

      let cameraBridge = usesSeparateCameraBridge ? cameraTentative : bridge;
      if (usesSeparateCameraBridge && Math.abs(cameraPlacement.placementHeight - cameraPlacement.ifcOriginHeight) > 1e-6) {
        const finalCamera = await createCesiumBridge(
          cameraConversion, projectedCRS, coordinateInfo, lengthUnitScale,
          cameraPlacement.placementHeight,
        );
        if (cancelled) return;
        cameraBridge = finalCamera ?? cameraTentative;
      }

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
    dataSource,
    storeyElevations,
    setCesiumTerrainHeight,
    setCesiumTerrainSource,
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
        const modelMatrix = buildModelMatrix(Cesium, bridge, mapConversion, projectedCRS, coordinateInfo, lengthUnitScale);

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

    const newMatrix = buildModelMatrix(Cesium, bridge, mapConversion, projectedCRS, coordinateInfo, lengthUnitScale);
    model.modelMatrix = newMatrix;
    viewer.scene.requestRender();
    // Depend on bridgeVersion so the matrix is rebuilt with the *new* bridge
    // after async createCesiumBridge replaces it. Placement is baked into
    // bridge.modelOrigin.height by Effect 2.
  }, [mapConversion, projectedCRS, coordinateInfo, lengthUnitScale, bridgeVersion]);

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
 * Add the Google Photorealistic 3D Tiles layer to the Cesium viewer.
 */
async function addDataSourceLayer(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  dataSource: string,
  ionToken: string,
) {
  try {
    switch (dataSource) {
      case 'google-photorealistic':
      default: {
        try {
          const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        viewer.scene.primitives.add(tileset);
        } catch {
          if (ionToken) {
            const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(2275207);
            viewer.scene.primitives.add(tileset);
          }
        }
        break;
      }
    }
  } catch (err) {
    console.warn('[CesiumOverlay] Failed to add data source:', dataSource, err);
  }
}
