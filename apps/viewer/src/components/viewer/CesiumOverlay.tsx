/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CesiumOverlay — renders a CesiumJS globe behind the WebGPU canvas,
 * providing real-world 3D context (terrain, buildings, imagery) for
 * georeferenced IFC models.
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
import { getEffectiveHorizontalScale } from '@/lib/geo/effective-georef';

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
  clamp: boolean,
  terrainH: number | null,
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

  let placementHeight = bridge.modelOrigin.height;
  if (clamp && terrainH !== null) {
    const minY = bounds?.min.y ?? 0;
    const bottomOffset = mvy - minY; // already in metres
    placementHeight = terrainH + bottomOffset;
  }

  const origin = Cesium.Cartesian3.fromDegrees(
    bridge.modelOrigin.longitude, bridge.modelOrigin.latitude, placementHeight,
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
  projectedCRS?: ProjectedCRS;
  coordinateInfo?: CoordinateInfo;
  geometryResult?: GeometryResult | null;
  /** IFC project length unit → metres (e.g. 0.001 for mm models). Default 1. */
  lengthUnitScale?: number;
}

export function CesiumOverlay({
  mapConversion,
  projectedCRS,
  coordinateInfo,
  geometryResult,
  lengthUnitScale = 1,
}: CesiumOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<InstanceType<typeof import('cesium').Viewer> | null>(null);
  const bridgeRef = useRef<CesiumBridge | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Tracks bridge readiness as state (not just a ref) so terrain query effect re-runs
  const [bridgeVersion, setBridgeVersion] = useState(0);

  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);
  const dataSource = useViewerStore((s) => s.cesiumDataSource);
  const ionToken = useViewerStore((s) => s.cesiumIonToken);
  const terrainEnabled = useViewerStore((s) => s.cesiumTerrainEnabled);
  const terrainClamp = useViewerStore((s) => s.cesiumTerrainClamp);
  const setCesiumTerrainClamp = useViewerStore((s) => s.setCesiumTerrainClamp);
  const terrainHeight = useViewerStore((s) => s.cesiumTerrainHeight);
  const setCesiumTerrainHeight = useViewerStore((s) => s.setCesiumTerrainHeight);
  const setCesiumTerrainClipY = useViewerStore((s) => s.setCesiumTerrainClipY);
  const setCesiumGlbLoaded = useViewerStore((s) => s.setCesiumGlbLoaded);

  // Use refs so the camera sync loop always reads the latest values
  const terrainClampRef = useRef(terrainClamp);
  const terrainHeightRef = useRef(terrainHeight);
  const coordinateInfoRef = useRef(coordinateInfo);
  terrainClampRef.current = terrainClamp;
  terrainHeightRef.current = terrainHeight;
  coordinateInfoRef.current = coordinateInfo;

  // Track whether we've auto-clamped to terrain (only once, so user can still uncheck)
  const autoClampedRef = useRef(false);

  // The world altitude where the model frame currently sits (in metres). When
  // this changes — user edits OrthogonalHeight, terrain clamp toggles, terrain
  // tile loads with a new height — we shift the IFC viewer's camera Y by the
  // inverse so the user's world camera position stays put. Without this, every
  // model-placement edit also translates the camera (because viewerToEcef and
  // modelMatrix share the same origin altitude), which is what makes editing
  // OrthogonalHeight feel like it's "moving the camera, not the model."
  const prevPlacementRef = useRef<number | null>(null);
  // Track that we've performed the initial above-ground lift so we don't fight
  // the user's camera once they're navigating.
  const initialLiftDoneRef = useRef(false);
  const terrainLiftDoneRef = useRef(false);

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  const cesiumModelRef = useRef<{ modelMatrix: any; destroy?: () => void } | null>(null);
  const glbCacheRef = useRef<{ meshCount: number; glb: Uint8Array } | null>(null);

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

        // Disable Cesium's user input — the IFC viewer controls the camera.
        // Keep collision detection off since we set the camera programmatically.
        const scene = viewer.scene;
        const sscc = scene.screenSpaceCameraController;
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

        // Add imagery
        try {
          const imageryProvider = await Cesium.IonImageryProvider.fromAssetId(2);
          viewer.imageryLayers.addImageryProvider(imageryProvider);
        } catch {
          viewer.imageryLayers.addImageryProvider(
            new Cesium.OpenStreetMapImageryProvider({
              url: 'https://a.tile.openstreetmap.org/',
            })
          );
        }

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

  // ─── Effect 2: Rebuild coordinate bridge when georef changes (fast) ─────
  // This is the live-edit handler. When the user changes EPSG, eastings,
  // northings, rotation, etc., we rebuild the bridge and fly to the new spot.
  useEffect(() => {
    if (status !== 'ready' || !mapConversion || !projectedCRS) {
      bridgeRef.current = null;
      prevPlacementRef.current = null;
      initialLiftDoneRef.current = false;
      terrainLiftDoneRef.current = false;
      return;
    }

    let cancelled = false;

    (async () => {
      const bridge = await createCesiumBridge(mapConversion, projectedCRS, coordinateInfo, lengthUnitScale);
      if (cancelled) return;

      if (!bridge) {
        bridgeRef.current = null;
        return;
      }

      const prevBridge = bridgeRef.current;
      bridgeRef.current = bridge;
      autoClampedRef.current = false; // reset for new bridge
      // Bump version so terrain query effect re-runs now that bridge is ready
      setBridgeVersion((v) => v + 1);

      // Fly to the new model location (smooth animation)
      const viewer = viewerRef.current;
      const Cesium = cesiumModule;
      if (viewer && Cesium) {
        const { modelOrigin } = bridge;

        const isFirstPosition = !prevBridge;
        const target = Cesium.Cartesian3.fromDegrees(
          modelOrigin.longitude, modelOrigin.latitude, modelOrigin.height,
        );

        if (isFirstPosition) {
          // First time: fly to the model location.
          // On first load terrain tiles may not be ready, so globe.getHeight
          // can return undefined. Use flyTo which handles terrain automatically,
          // targeting a safe altitude above the model origin.
          const safeHeight = Math.max(modelOrigin.height, 100);
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
              modelOrigin.longitude, modelOrigin.latitude, safeHeight + 500,
            ),
            orientation: {
              heading: 0,
              pitch: Cesium.Math.toRadians(-45),
              roll: 0,
            },
            duration: 0, // instant
          });
        } else if (prevBridge) {
          // Georef edit: just re-render, the camera sync loop will pick
          // up the new bridge on the next frame. No dramatic fly animation.
          viewer.scene.requestRender();
        }
      }
    })();

    return () => { cancelled = true; };
  }, [status, mapConversion, projectedCRS, coordinateInfo, lengthUnitScale]);

  // ─── Effect 2b: Query terrain height when bridge is ready ───────────────
  // Also re-queries when terrainClamp is toggled on (in case first query failed)
  useEffect(() => {
    if (status !== 'ready') return;
    const bridge = bridgeRef.current;
    const viewer = viewerRef.current;
    const Cesium = cesiumModule;
    if (!bridge || !viewer || !Cesium) return;

    let cancelled = false;

    // Query immediately, then retry after a delay if terrain tiles weren't loaded yet
    // Compute model center Y in viewer space for terrain clip offset
    const bounds = coordinateInfo?.originalBounds;
    const modelVY = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
    const modelMinY = bounds ? bounds.min.y : 0;

    const doQuery = () => {
      bridge.queryTerrainHeight(Cesium, viewer).then((h) => {
        if (!cancelled && h !== null) {
          setCesiumTerrainHeight(h);
          // Compute terrain clip Y in viewer space (both h and modelOrigin.height are metres,
          // bounds are also in metres since the geometry engine converts during extraction)
          const terrainClipY = modelMinY + (h - bridge.modelOrigin.height);
          setCesiumTerrainClipY(terrainClipY);

          // Auto-enable terrain clamping if the model is significantly below terrain
          // (only once — don't override if the user has manually toggled)
          if (!autoClampedRef.current && h > bridge.modelOrigin.height + 5) {
            autoClampedRef.current = true;
            setCesiumTerrainClamp(true);
            // Fly camera to the clamped position so the model is visible
            viewer.camera.flyTo({
              destination: Cesium.Cartesian3.fromDegrees(
                bridge.modelOrigin.longitude, bridge.modelOrigin.latitude, h + 500,
              ),
              orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
              duration: 0,
            });
          }
        }
      });
    };

    // First attempt
    doQuery();
    // Retry after 5s in case terrain tiles were still loading
    const retryTimer = setTimeout(doQuery, 5000);

    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, [status, terrainEnabled, terrainClamp, bridgeVersion]);

  // ─── Effect 2bb: Anchor the IFC camera to the world ───────────────────
  // Two responsibilities, both rooted in the fact that viewerToEcef and
  // modelMatrix share the same enuToEcef origin altitude:
  //
  // 1. STABILITY — when the model placement altitude changes (user edits
  //    OrthogonalHeight, terrain clamp toggles, etc.) we shift the IFC
  //    camera Y by the inverse delta. Without this, editing the model feels
  //    like it's moving the camera because the entire frame translates.
  //
  // 2. ABOVE-GROUND — on first activation (and once when terrain becomes
  //    known) lift the camera if its world altitude lands at or below the
  //    surface. Models authored at low elevations or sites in alpine regions
  //    otherwise leave the user buried, fighting Cesium's near-surface
  //    controls to climb back out.
  useEffect(() => {
    if (status !== 'ready') return;
    const bridge = bridgeRef.current;
    const renderer = getGlobalRenderer();
    if (!bridge || !renderer) return;

    const bounds = coordinateInfo?.originalBounds;
    const mvy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
    const minY = bounds?.min.y ?? 0;
    const placement = (terrainClamp && terrainHeight !== null)
      ? terrainHeight + (mvy - minY)
      : bridge.modelOrigin.height;

    const prev = prevPlacementRef.current;
    prevPlacementRef.current = placement;
    const cam = renderer.getCamera();
    const pos = cam.getPosition();
    let newY = pos.y;

    // 1. Stability — compensate placement delta so the world camera position
    //    stays fixed across edits. Only the camera POSITION is shifted; the
    //    target stays put in viewer-space so its world altitude (placement +
    //    target.y − mvy) tracks the model. That way the camera keeps looking
    //    AT the model, not at the empty space the model used to occupy.
    if (prev !== null) {
      const dh = placement - prev;
      if (Math.abs(dh) > 1e-6) {
        newY -= dh;
      }
    }

    // 2. Above-ground lift — at most twice: once on first bridge
    //    (no terrain yet → guarantee above the model frame), once when
    //    terrain first becomes known (lift above terrain if still below).
    //    Only triggers when the user is actually at or below the surface;
    //    a normal "above ground" view is left alone so we don't fight a
    //    user who deliberately zoomed close.
    const isFirstBridge = !initialLiftDoneRef.current;
    const terrainJustKnown = terrainHeight !== null && !terrainLiftDoneRef.current;
    if (isFirstBridge || terrainJustKnown) {
      if (isFirstBridge) initialLiftDoneRef.current = true;
      if (terrainHeight !== null) terrainLiftDoneRef.current = true;

      const groundFloor = (terrainHeight !== null)
        ? Math.max(terrainHeight, placement)
        : placement;
      const currentWorldAlt = placement + (newY - mvy);
      if (currentWorldAlt <= groundFloor) {
        // Lift to a sensible viewing altitude above ground — at least 100 m
        // or the model height, whichever is larger, so the user can see the
        // model without immediately fighting Cesium's slow near-surface
        // controls. Only POSITION lifts; target stays anchored to the model
        // so the building sits roughly centred (rather than pinned to the
        // bottom of the viewport).
        const modelH = bounds ? bounds.max.y - bounds.min.y : 0;
        const buffer = Math.max(100, modelH);
        const lift = (groundFloor + buffer) - currentWorldAlt;
        newY += lift;
      }
    }

    if (newY !== pos.y) {
      cam.setPosition(pos.x, newY, pos.z);
    }
  }, [status, bridgeVersion, terrainClamp, terrainHeight, coordinateInfo]);

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
        const modelMatrix = buildModelMatrix(Cesium, bridge, mapConversion, projectedCRS, coordinateInfo, terrainClampRef.current, terrainHeightRef.current, lengthUnitScale);

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
  // When terrain clamp, terrain height, or georef changes, just update the
  // existing model's matrix — no GLB re-export, no flicker.
  useEffect(() => {
    const model = cesiumModelRef.current;
    const bridge = bridgeRef.current;
    const viewer = viewerRef.current;
    const Cesium = cesiumModule;
    if (!model || !bridge || !viewer || !Cesium) return;

    const newMatrix = buildModelMatrix(Cesium, bridge, mapConversion, projectedCRS, coordinateInfo, terrainClamp, terrainHeight, lengthUnitScale);
    model.modelMatrix = newMatrix;
    viewer.scene.requestRender();
    // Depend on bridgeVersion so the matrix is rebuilt with the *new* bridge
    // after an async createCesiumBridge replaces it. Without this, a georef
    // edit synchronously fires this effect with the OLD bridge (giving a
    // mixed matrix) and never re-runs once the new bridge resolves.
  }, [terrainClamp, terrainHeight, mapConversion, projectedCRS, coordinateInfo, lengthUnitScale, bridgeVersion]);

  // ─── Effect 3: Camera sync loop ─────────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready') return;

    const viewer = viewerRef.current;
    if (!viewer) return;

    let cancelled = false;

    function syncCamera() {
      if (cancelled) return;

      const bridge = bridgeRef.current;
      const renderer = getGlobalRenderer();
      const Cesium = cesiumModule;
      if (!viewer || !bridge || !renderer || !Cesium) {
        rafRef.current = requestAnimationFrame(syncCamera);
        return;
      }

      const camera = renderer.getCamera();
      const camPos = camera.getPosition();
      const camTarget = camera.getTarget();
      const camUp = camera.getUp();
      const fov = camera.getFOV();

      // Camera frame must share the model's enuToEcef origin altitude or the
      // GLB and the camera diverge (model rendered above/below where the IFC
      // viewer thinks the camera is looking). When terrain clamping moves the
      // model up to the terrain surface, lift the camera frame the same way.
      const bounds = coordinateInfoRef.current?.originalBounds;
      const mvyForClamp = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
      const minYForClamp = bounds?.min.y ?? 0;
      let clampOffset = 0;
      if (terrainClampRef.current && terrainHeightRef.current !== null) {
        const placement = terrainHeightRef.current + (mvyForClamp - minYForClamp);
        clampOffset = placement - bridge.modelOrigin.height;
      }
      bridge.syncCamera(Cesium, viewer, camPos, camTarget, camUp, fov, clampOffset);

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
  }, [status]);

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
 * Add the selected 3D data source layer to the Cesium viewer.
 */
async function addDataSourceLayer(
  Cesium: typeof import('cesium'),
  viewer: InstanceType<typeof import('cesium').Viewer>,
  dataSource: string,
  ionToken: string,
) {
  try {
    switch (dataSource) {
      case 'osm-buildings': {
        if (!ionToken) return;
        const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(96188);
        viewer.scene.primitives.add(tileset);
        break;
      }
      case 'google-photorealistic': {
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
      case 'bing-aerial':
      default:
        // No 3D tileset for Bing — imagery is added separately via imageryLayers
        break;
    }
  } catch (err) {
    console.warn('[CesiumOverlay] Failed to add data source:', dataSource, err);
  }
}
