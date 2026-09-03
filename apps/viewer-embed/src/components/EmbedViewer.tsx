/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Embed viewer: Viewport-only layout with no panels, toolbar, or chrome.
 *
 * Reuses the main viewer's Viewport component via the @ alias (which points
 * to apps/viewer/src/). The embed app shares the same Zustand store instance
 * as the viewer -- it just doesn't render panels, toolbars, or measurement UI.
 *
 * Communication with the host page happens via postMessage (the bridge) and URL params.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Viewport } from '@/components/viewer/Viewport';
import { ViewportOverlays } from '@/components/viewer/ViewportOverlays';
import { useIfc } from '@/hooks/useIfc';
import { useWebGPU } from '@/hooks/useWebGPU';
import { useViewerStore } from '@/store';
import { useModelViewGeometry } from './useModelViewGeometry.js';
import { toGlobalIdFromModels } from '@/store/globalId';
import { parseUrlParams, assertFetchableUrl } from '../bridge/urlParams.js';
import { initBridge, destroyBridge, emitEvent } from '../bridge/handler.js';
import { aroundDestructiveLoad } from '../bridge/cameraIntent.js';
import { mountBridgeLifecycle, unmountBridgeLifecycle } from '../bridge/lifecycle.js';
import { useEmbedBridgeEvents } from './useEmbedBridgeEvents.js';
import { useEmbedPostLoad } from './useEmbedPostLoad.js';
import { useEmbedUrlParams, useHostHiddenIfcTypes } from './useEmbedUrlParams.js';
import { useEmbedRuntimeOverlays } from './useEmbedRuntimeOverlays.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

export function EmbedViewer() {
  const webgpu = useWebGPU();
  const { geometryResult, ifcDataStore, loadFile, loading, addModel } = useIfc();
  const storeModels = useViewerStore((s) => s.models);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const theme = useViewerStore((s) => s.theme);
  const setTheme = useViewerStore((s) => s.setTheme);
  const progress = useViewerStore((s) => s.progress);
  const error = useViewerStore((s) => s.error);
  const [urlParams] = useState(() => parseUrlParams());
  const bridgeInitialized = useRef(false);
  const autoLoadAttempted = useRef(false);
  // Seeded from ?bg=; can also be set at runtime via SET_THEME's/INIT's `bg`
  // (see setBackgroundColor passed into initBridge below). Stored bare (no
  // leading '#') to match the URL-param convention and normalized to CSS
  // color the same way in both places.
  const [customBgHex, setCustomBgHex] = useState<string | undefined>(urlParams.bg);
  // Same rationale as customBgHex above, for INIT's config.hideAxis/.hideScale/.hideTypes (#2934 follow-up).
  const { hideAxis, hideScale, hideTypes, setOverlays } = useEmbedRuntimeOverlays(urlParams);

  // Apply URL params on mount. Embeds default to light unless ?theme=dark
  // (the surrounding viewer-core store may bootstrap to dark based on system
  // preference, which is wrong for a third-party iframe with no chrome).
  useEffect(() => {
    setTheme(urlParams.theme === 'dark' ? 'dark' : 'light');
  }, [urlParams.theme, setTheme]);

  // Force hover picking on. `hoverState` (apps/viewer/src/store/slices/
  // hoverSlice.ts) is populated by useMouseControls.ts's throttled
  // renderer.pick() on mousemove — the same pipeline the main viewer uses —
  // but that whole branch is gated behind `hoverTooltipsEnabled`, which
  // defaults to false (a toolbar toggle). The embed has no toolbar to flip it,
  // and the ENTITY_HOVERED effect below needs `hoverState` to ever populate.
  // Safe to force on here: the embed shell never renders <HoverTooltip> (it
  // lives in ViewerLayout, which the embed doesn't use), so this activates the
  // picking pipeline only — no tooltip UI appears.
  useEffect(() => {
    useViewerStore.setState({ hoverTooltipsEnabled: true });
  }, []);

  // Initialize the postMessage bridge.
  //
  // Guarded via mountBridgeLifecycle/unmountBridgeLifecycle so a React 19
  // <StrictMode> mount -> cleanup -> remount cycle (dev only) re-initializes
  // instead of leaving the bridge permanently dead: the mount side was
  // ref-guarded but the cleanup never reset it, so the remount saw the guard
  // already set, skipped initBridge(), and the inbound listener stayed removed.
  useEffect(() => {
    mountBridgeLifecycle(bridgeInitialized, () => {
      // Derive the expected parent origin (so content-bearing auto-load events
      // are not broadcast to '*' before any inbound command arrives): prefer the
      // explicit ?parentOrigin= param, then fall back to the referrer's origin.
      let expectedParentOrigin = urlParams.parentOrigin;
      if (!expectedParentOrigin && document.referrer) {
        try {
          expectedParentOrigin = new URL(document.referrer).origin;
        } catch (error) {
          // Malformed referrer — leave undefined and rely on the inbound handshake.
          console.warn('[embed] Failed to derive parent origin from document.referrer', document.referrer, error);
          expectedParentOrigin = undefined;
        }
      }

      initBridge({
        getState: () => useViewerStore.getState(),
        loadModelFromUrl: async (url: string) => {
          // Enforce the same http(s)-only allowlist as the URL-param path so the
          // postMessage bridge can't be steered to file:/data:/internal targets.
          const safeUrl = assertFetchableUrl(url);
          const response = await fetch(safeUrl, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`Failed to fetch model: ${response.statusText}`);
          const buffer = await response.arrayBuffer();
          const filename = url.split('/').pop() || 'model.ifc';
          const file = new File([buffer], filename);
          await loadFile(file);
          const state = useViewerStore.getState();
          const gr = state.geometryResult;
          return {
            entities: state.ifcDataStore?.entities?.count ?? 0,
            triangles: gr?.totalTriangles ?? 0,
            vertices: gr?.totalVertices ?? 0,
          };
        },
        loadModelFromBuffer: async (buffer: ArrayBuffer, name?: string) => {
          const file = new File([buffer], name || 'model.ifc');
          await loadFile(file);
          const state = useViewerStore.getState();
          const gr = state.geometryResult;
          return {
            entities: state.ifcDataStore?.entities?.count ?? 0,
            triangles: gr?.totalTriangles ?? 0,
            vertices: gr?.totalVertices ?? 0,
          };
        },
        addModelFromUrl: async (url: string, name?: string) => {
          // Federation-aware add: routes through useIfcFederation's addModel,
          // which loads with target `{ kind: 'federated' }` and therefore does
          // NOT clear existing models (unlike loadFile's default primary
          // target, which loadModelFromUrl above uses for LOAD_MODEL).
          const safeUrl = assertFetchableUrl(url);
          const response = await fetch(safeUrl, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`Failed to fetch model: ${response.statusText}`);
          const buffer = await response.arrayBuffer();
          const filename = url.split('/').pop() || 'model.ifc';
          const file = new File([buffer], name || filename);
          const modelId = await addModel(file);
          if (!modelId) throw new Error('Failed to add model');
          const added = useViewerStore.getState().models.get(modelId);
          return {
            modelId,
            entities: added?.ifcDataStore?.entities?.count ?? 0,
            triangles: added?.geometryResult?.totalTriangles ?? 0,
            vertices: added?.geometryResult?.totalVertices ?? 0,
          };
        },
        setBackgroundColor: (bg: string | undefined) => setCustomBgHex(bg),
        setOverlays,
      }, {
        allowedOrigins: urlParams.allowOrigins,
        expectedParentOrigin,
      });
    });

    // The bridge only. The camera queue is NOT reset here: the `?modelUrl=`
    // auto-load below drives it without the bridge ever seeing it, and this
    // cleanup also fires on StrictMode's dev-only remount, mid-fetch, where
    // zeroing it drops the held pose and un-counts the rest of the load
    // (EmbedViewer.cameraIntent.test.ts pins that case). A real unmount needs
    // no reset: the embed mounts once and the state dies with the page.
    return () => unmountBridgeLifecycle(bridgeInitialized, destroyBridge);
  }, [loadFile, addModel, urlParams.allowOrigins, urlParams.parentOrigin]);

  // Auto-load model from URL param
  useEffect(() => {
    if (autoLoadAttempted.current) return;
    if (!urlParams.modelUrl || urlParams.autoLoad === false || !webgpu.supported || loading) return;
    if (storeModels.size > 0 || geometryResult?.meshes?.length) return;

    autoLoadAttempted.current = true;

    (async () => {
      try {
        emitEvent('MODEL_LOADING', { progress: 0, phase: 'Fetching model...' });
        // Same scene-replacing window the bridge's LOAD_MODEL has (#3390): the
        // fetch runs long before `loadFile`'s session reset, so a host
        // SET_CAMERA arriving in between is held for the incoming model.
        await aroundDestructiveLoad(useViewerStore.getState, async () => {
          const response = await fetch(urlParams.modelUrl!, { signal: AbortSignal.timeout(60_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          const filename = urlParams.modelUrl!.split('/').pop() || 'model.ifc';
          const file = new File([buffer], filename);
          await loadFile(file);
        });
      } catch (err) {
        emitEvent('MODEL_ERROR', {
          error: {
            code: 'LOAD_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
  }, [urlParams.modelUrl, urlParams.autoLoad, webgpu.supported, loading, loadFile, storeModels.size, geometryResult?.meshes?.length]);

  // Emit progress events to parent
  useEffect(() => {
    if (progress) {
      emitEvent('MODEL_LOADING', { progress: progress.percent, phase: progress.phase });
    }
  }, [progress]);

  // MODEL_LOADED, the camera pose a host queued against this load, and
  // first-load framing — see useEmbedPostLoad.ts.
  useEmbedPostLoad(loading, geometryResult, ifcDataStore, urlParams);

  // Outbound store-change events (ENTITY_SELECTED / ENTITY_HOVERED /
  // CAMERA_CHANGED / SECTION_CHANGED) — see useEmbedBridgeEvents.ts.
  useEmbedBridgeEvents();

  // Apply ?select= / ?isolate= once the first model is on screen.
  useEmbedUrlParams(urlParams, Boolean(geometryResult?.meshes?.length || storeModels.size));

  // Multi-model: create mapping from modelId to modelIndex
  const modelIdToIndex = useMemo(() => {
    const map = new Map<string, number>();
    let index = 0;
    for (const modelId of storeModels.keys()) {
      map.set(modelId, index++);
    }
    return map;
  }, [storeModels]);

  // Merge geometries from all visible models
  const mergedGeometryResult = useMemo(() => {
    if (storeModels.size > 0) {
      const allMeshes: MeshData[] = [];
      let totalVertices = 0;
      let totalTriangles = 0;
      let mergedCoordinateInfo: CoordinateInfo | undefined;

      for (const [modelId, model] of storeModels) {
        if (!model.visible) continue;
        const mg = model.geometryResult;
        const mi = modelIdToIndex.get(modelId) ?? 0;
        if (mg?.meshes) {
          for (const mesh of mg.meshes) {
            allMeshes.push({ ...mesh, modelIndex: mi });
          }
          totalVertices += mg.totalVertices || 0;
          totalTriangles += mg.totalTriangles || 0;
          if (!mergedCoordinateInfo && mg.coordinateInfo) mergedCoordinateInfo = mg.coordinateInfo;
        }
      }

      return { meshes: allMeshes, totalVertices, totalTriangles, coordinateInfo: mergedCoordinateInfo };
    }
    return geometryResult;
  }, [storeModels, geometryResult, modelIdToIndex]);

  // Then type visibility, plus the host's ?hideTypes=: ARBITRARY IFC class
  // names (the SDK ships `hideTypes?: string[]`), so not a `typeVisibility`
  // toggle but a case-folded membership test merged into that same filter pass.
  // The hook also publishes the set to the store, the only route to the 2D
  // overlay, which is not a mesh and so is unreachable from here (#2934).
  const hiddenTypes = useHostHiddenIfcTypes(hideTypes);
  const { geometry: filteredGeometry, contentVersion } = useModelViewGeometry(
    mergedGeometryResult,
    hiddenTypes,
    typeVisibility,
  );

  // Compute isolation set
  const computedIsolatedIds = useMemo(() => {
    if (isolatedEntities !== null) return isolatedEntities;
    if (selectedStoreys.size > 0) {
      const combinedGlobalIds = new Set<number>();
      for (const [, model] of storeModels) {
        const hierarchy = model.ifcDataStore?.spatialHierarchy;
        if (!hierarchy) continue;
        const offset = model.idOffset ?? 0;
        for (const storeyId of selectedStoreys) {
          const elements = hierarchy.byStorey.get(storeyId) || hierarchy.byStorey.get(storeyId - offset);
          if (elements) for (const id of elements) combinedGlobalIds.add(toGlobalIdFromModels(storeModels, model.id, id));
        }
      }
      if (combinedGlobalIds.size > 0) return combinedGlobalIds;
    }
    return null;
  }, [storeModels, selectedStoreys, isolatedEntities]);

  // Background color
  const bgColor = theme === 'dark' ? '#1a1b26' : '#ffffff';
  const customBg = customBgHex ? `#${customBgHex}` : undefined;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: customBg || bgColor,
      }}
    >
      {/* WebGPU check */}
      {!webgpu.checking && !webgpu.supported && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui', color: theme === 'dark' ? '#a9b1d6' : '#333',
        }}>
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <p style={{ fontSize: '1.2rem', fontWeight: 700 }}>WebGPU Not Available</p>
            <p style={{ fontSize: '0.85rem', opacity: 0.7, marginTop: '0.5rem' }}>
              {webgpu.reason || 'This viewer requires WebGPU support.'}
            </p>
          </div>
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui', color: theme === 'dark' ? '#a9b1d6' : '#333', zIndex: 10,
          background: theme === 'dark' ? 'rgba(26,27,38,0.8)' : 'rgba(255,255,255,0.8)',
        }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '0.9rem', fontWeight: 600 }}>
              {progress?.phase || 'Loading...'}
            </p>
            {progress && (
              <div style={{
                width: '200px', height: '4px', background: theme === 'dark' ? '#3b4261' : '#e5e7eb',
                borderRadius: '2px', marginTop: '0.75rem', overflow: 'hidden',
              }}>
                <div style={{
                  width: `${progress.percent}%`, height: '100%',
                  background: '#7aa2f7', transition: 'width 0.3s',
                }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error indicator */}
      {error && !loading && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui', color: '#f7768e', zIndex: 10,
        }}>
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <p style={{ fontSize: '0.9rem', fontWeight: 600 }}>Error</p>
            <p style={{ fontSize: '0.8rem', opacity: 0.8, marginTop: '0.5rem' }}>{error}</p>
          </div>
        </div>
      )}

      {/* Empty state: no model loaded and nothing in progress */}
      {!loading && !error && !filteredGeometry?.length && !urlParams.modelUrl && webgpu.supported && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'system-ui', color: theme === 'dark' ? '#565f89' : '#9ca3af',
        }}>
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <p style={{ fontSize: '0.9rem' }}>No model loaded</p>
            <p style={{ fontSize: '0.75rem', opacity: 0.7, marginTop: '0.4rem' }}>
              Use the SDK or pass a <code style={{ opacity: 0.9 }}>modelUrl</code> parameter
            </p>
          </div>
        </div>
      )}

      {/* 3D Viewport — wrapper ensures canvas fills the container even
           when Tailwind utility classes (w-full h-full) are not generated */}
      {webgpu.supported && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <Viewport
            geometry={filteredGeometry}
            geometryContentVersion={contentVersion}
            coordinateInfo={mergedGeometryResult?.coordinateInfo}
            computedIsolatedIds={computedIsolatedIds}
            modelIdToIndex={modelIdToIndex}
          />
          <ViewportOverlays hideViewCube hideAxis={hideAxis} hideScale={hideScale} />
        </div>
      )}
    </div>
  );
}
