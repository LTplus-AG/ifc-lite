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
import { toGlobalIdFromModels } from '@/store/globalId';
import { parseUrlParams } from '../bridge/urlParams.js';
import { initBridge, destroyBridge, emitEvent } from '../bridge/handler.js';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

export function EmbedViewer() {
  const webgpu = useWebGPU();
  const { geometryResult, ifcDataStore, loadFile, loading, models, clearAllModels } = useIfc();
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

  // Apply URL params on mount. Embeds default to light unless ?theme=dark
  // (the surrounding viewer-core store may bootstrap to dark based on system
  // preference, which is wrong for a third-party iframe with no chrome).
  useEffect(() => {
    setTheme(urlParams.theme === 'dark' ? 'dark' : 'light');
  }, [urlParams.theme, setTheme]);

  // Initialize the postMessage bridge
  useEffect(() => {
    if (bridgeInitialized.current) return;
    bridgeInitialized.current = true;

    initBridge({
      getState: () => useViewerStore.getState(),
      loadModelFromUrl: async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
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
    });

    return () => destroyBridge();
  }, [loadFile]);

  // Auto-load model from URL param
  useEffect(() => {
    if (autoLoadAttempted.current) return;
    if (!urlParams.modelUrl || !webgpu.supported || loading) return;
    if (storeModels.size > 0 || geometryResult?.meshes?.length) return;

    autoLoadAttempted.current = true;

    (async () => {
      try {
        emitEvent('MODEL_LOADING', { progress: 0, phase: 'Fetching model...' });
        const response = await fetch(urlParams.modelUrl!, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const filename = urlParams.modelUrl!.split('/').pop() || 'model.ifc';
        const file = new File([buffer], filename);
        await loadFile(file);
      } catch (err) {
        emitEvent('MODEL_ERROR', {
          error: {
            code: 'LOAD_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
  }, [urlParams.modelUrl, webgpu.supported, loading, loadFile, storeModels.size, geometryResult?.meshes?.length]);

  // Emit progress events to parent
  useEffect(() => {
    if (progress) {
      emitEvent('MODEL_LOADING', { progress: progress.percent, phase: progress.phase });
    }
  }, [progress]);

  // Emit model loaded event + auto-fit camera on the first model that lands.
  // Unlike the full viewer (which has toolbar buttons for fit-all and a default
  // load flow that fits), the embed has no chrome — so without an explicit fit
  // call the camera stays at its initial position and the model renders off-frame.
  // We only fit on the *first* successful load so host-driven SET_CAMERA / view
  // params via the bridge aren't immediately overridden.
  const autoFittedRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    const meshes = geometryResult?.meshes;
    if (!meshes || meshes.length === 0) return;

    emitEvent('MODEL_LOADED', {
      entities: ifcDataStore?.entities?.count ?? 0,
      triangles: geometryResult.totalTriangles,
      vertices: geometryResult.totalVertices,
    });

    if (autoFittedRef.current) return;

    // Viewport registers cameraCallbacks AFTER renderer.init() resolves (async).
    // On a fast network + small model, geometry can land before that happens.
    // Poll for up to ~2 s, checking each frame, then bail out so we never leak.
    autoFittedRef.current = true;
    const deadline = performance.now() + 2000;
    let rafId = 0;
    const tryFit = () => {
      const cbs = useViewerStore.getState().cameraCallbacks;
      const ready = Boolean(cbs.home || cbs.fitAll || cbs.setPresetView);
      console.log('[embed] auto-fit tick', {
        ready,
        cbs: Object.keys(cbs),
        view: urlParams.view,
        camera: urlParams.camera,
        meshes: meshes.length,
      });
      if (!ready) {
        if (performance.now() < deadline) {
          rafId = requestAnimationFrame(tryFit);
        } else {
          console.warn('[embed] auto-fit gave up — cameraCallbacks never registered');
        }
        return;
      }
      // Honour ?view= / ?camera= URL params first; only auto-fit if neither was set.
      if (urlParams.view) {
        console.log('[embed] auto-fit: setPresetView', urlParams.view);
        cbs.setPresetView?.(urlParams.view);
      } else if (urlParams.camera) {
        console.log('[embed] auto-fit: skipped (?camera= handled elsewhere)');
      } else if (cbs.home) {
        console.log('[embed] auto-fit: home()');
        cbs.home();
      } else if (cbs.fitAll) {
        console.log('[embed] auto-fit: fitAll() fallback');
        cbs.fitAll();
      }
    };
    rafId = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(rafId);
  }, [loading, geometryResult, ifcDataStore, urlParams.view, urlParams.camera]);

  // Emit selection events to parent
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  useEffect(() => {
    if (selectedEntityId !== null) {
      // Resolve metadata for the selected entity
      const state = useViewerStore.getState();
      const lookup = state.resolveGlobalIdFromModels(selectedEntityId);
      const model = lookup ? state.models.get(lookup.modelId) : undefined;
      const entities = model?.ifcDataStore?.entities;
      emitEvent('ENTITY_SELECTED', {
        id: selectedEntityId,
        globalId: entities?.getGlobalId(lookup?.expressId ?? selectedEntityId) ?? undefined,
        modelId: lookup?.modelId,
        ifcType: entities?.getTypeName(lookup?.expressId ?? selectedEntityId) ?? undefined,
      });
    } else {
      emitEvent('ENTITY_DESELECTED', undefined);
    }
  }, [selectedEntityId]);

  // Emit camera rotation changes to parent (throttled)
  const cameraRotation = useViewerStore((s) => s.cameraRotation);
  const lastCameraEmit = useRef(0);
  useEffect(() => {
    const now = Date.now();
    if (now - lastCameraEmit.current < 100) return; // throttle to 10Hz
    lastCameraEmit.current = now;
    emitEvent('CAMERA_CHANGED', {
      azimuth: cameraRotation.azimuth,
      elevation: cameraRotation.elevation,
    });
  }, [cameraRotation]);

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

  // Filter by type visibility
  const filteredGeometry = useMemo(() => {
    if (!mergedGeometryResult?.meshes) return null;
    let meshes = mergedGeometryResult.meshes;

    meshes = meshes.filter(mesh => {
      if (mesh.ifcType === 'IfcSpace' && !typeVisibility.spaces) return false;
      if (mesh.ifcType === 'IfcOpeningElement' && !typeVisibility.openings) return false;
      if (mesh.ifcType === 'IfcSite' && !typeVisibility.site) return false;
      return true;
    });

    meshes = meshes.map(mesh => {
      if (mesh.ifcType === 'IfcSpace' || mesh.ifcType === 'IfcOpeningElement') {
        return { ...mesh, color: [mesh.color[0], mesh.color[1], mesh.color[2], Math.min(mesh.color[3] * 0.3, 0.3)] as [number, number, number, number] };
      }
      return mesh;
    });

    return meshes;
  }, [mergedGeometryResult, typeVisibility]);

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
  const customBg = urlParams.bg ? `#${urlParams.bg}` : undefined;

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
            coordinateInfo={mergedGeometryResult?.coordinateInfo}
            computedIsolatedIds={computedIsolatedIds}
            modelIdToIndex={modelIdToIndex}
          />
          <ViewportOverlays hideViewCube />
        </div>
      )}
    </div>
  );
}
