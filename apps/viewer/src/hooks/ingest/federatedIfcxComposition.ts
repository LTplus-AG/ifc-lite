/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publish a composed federated IFCX result into the viewer: the layer stack,
 * the shared composed data store, and one model per layer (the base layer
 * carries the geometry). The load contract around it (session, Cancel,
 * activity, shared load UI) stays with `useIfcFederation`.
 */

import type { parseFederatedIfcx } from '@ifc-lite/ifcx';
import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { toast } from '../../components/ui/toast.js';
import { layerStackEntry } from '../../lib/layers/stack.js';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import { calculateMeshBounds, createCoordinateInfo } from '../../utils/localParsingUtils.js';
import { buildIfcxDataStore, convertIfcxMeshes } from './viewerModelIngest.js';

/**
 * Extended data store type for IFCX (IFC5) files.
 * IFCX uses schemaVersion 'IFC5' and may include federated composition metadata.
 */
export interface IfcxDataStore extends IfcDataStore {
  schemaVersion: 'IFC5';
  /** Federated layer info for re-composition */
  _federatedLayers?: Array<{ id: string; name: string; enabled: boolean }>;
  /** Original buffers for re-composition when adding overlays */
  _federatedBuffers?: Array<{ buffer: ArrayBuffer; name: string }>;
  /** Composition statistics */
  _compositionStats?: { layersUsed: number; inheritanceResolutions: number; crossLayerReferences: number };
  /** Layer info for display */
  _layerInfo?: Array<{ id: string; name: string; meshCount: number }>;
}

export function publishFederatedIfcxComposition(
  result: Awaited<ReturnType<typeof parseFederatedIfcx>>,
  buffers: Array<{ buffer: ArrayBuffer; name: string }>,
): void {
  const state = useViewerStore.getState();
  // Convert IFCX meshes to viewer format
  const meshes: MeshData[] = convertIfcxMeshes(result.meshes);

  // Calculate bounds
  const { bounds, stats } = calculateMeshBounds(meshes);
  const coordinateInfo = createCoordinateInfo(bounds);

  const geometryResult = {
    meshes,
    totalVertices: stats.totalVertices,
    totalTriangles: stats.totalTriangles,
    coordinateInfo,
  };

  // NOTE: Do NOT call setGeometryResult() here!
  // For federated loading, geometry comes from the models Map via mergedGeometryResult.
  // Calling setGeometryResult() before models are added causes a race condition where
  // meshes are added to the scene WITHOUT modelIndex, breaking selection highlighting.

  // Get layer info with mesh counts
  const layers = result.layerStack.getLayers();

  // Layers panel (#1717): expose the stack behind this composition.
  // getLayers() is strongest-first; the panel slice keeps composition
  // order (weakest first). The parser retains each parsed IfcxFile, so
  // entries reference them without re-parsing.
  state.setLayerStack(
    [...layers].reverse().map((layer) => layerStackEntry(layer)),
    result.pathToId ?? null,
  );
  // First composed stack this browser has seen: open the Layers panel
  // once so the feature introduces itself (#1717 exposure). Never
  // repeats — after that the rail icon, badge, and menus carry it.
  if (layers.length >= 2 && typeof window !== 'undefined') {
    const INTRO_KEY = 'ifc-lite:layers:intro-shown';
    try {
      if (!window.localStorage.getItem(INTRO_KEY)) {
        window.localStorage.setItem(INTRO_KEY, '1');
        state.openWorkspacePanel('layers', 'programmatic');
        toast.info(
          `Composed ${layers.length} layers - inspect, diff, publish, and merge them in the Layers panel.`,
        );
      }
    } catch {
      /* private-mode storage failures must never break loading */
    }
  }

  // Create data store from federated result. Route through the shared
  // IFCX store factory so the lazy accessors (getEntity/getProperties/
  // getQuantities) the query + mutation paths call exist — without
  // them, selecting or editing an entity in a federated model threw
  // "this.store.getProperties is not a function" (#1717 V2).
  const accessorStore = buildIfcxDataStore(result, buffers[0].buffer);
  const dataStore = Object.assign(accessorStore, {
    // Federated-specific: store layer info and ORIGINAL BUFFERS for re-composition
    _federatedLayers: layers.map((l: { id: string; name: string; enabled: boolean }) => ({
      id: l.id,
      name: l.name,
      enabled: l.enabled,
    })),
    _federatedBuffers: buffers.map(b => ({
      buffer: b.buffer.slice(0), // Clone buffer
      name: b.name,
    })),
    _compositionStats: result.compositionStats,
  }) as unknown as IfcxDataStore;

  // IfcxDataStore extends IfcDataStore (with schemaVersion: 'IFC5'), so this is safe
  state.setIfcDataStore(dataStore);

  // Clear existing models and add each layer as a "model" in the Models panel
  // This shows users all the files that contributed to the composition
  state.clearAllModels();

  // Find max expressId for proper ID range tracking
  // This is needed for resolveGlobalIdFromModels to work correctly
  let maxExpressId = 0;
  if (result.entities?.expressId) {
    // @raw-entity-enumeration-ok load-time ID watermark scans the newly composed IFCX table before any session overlay is installed
    for (let i = 0; i < result.entities.count; i++) {
      const id = result.entities.expressId[i];
      if (id > maxExpressId) maxExpressId = id;
    }
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const layerBuffer = buffers.find(b => b.name === layer.name);

    // Count how many meshes came from this layer
    // For base layers: count meshes, for overlays: show as data-only
    const isBaseLayer = i === layers.length - 1; // Last layer (weakest) is typically base

    const layerModel: FederatedModel = {
      id: layer.id,
      name: layer.name,
      ifcDataStore: dataStore, // Share the composed data store
      geometryResult: isBaseLayer ? geometryResult : {
        meshes: [],
        totalVertices: 0,
        totalTriangles: 0,
        coordinateInfo,
      },
      visible: true,
      collapsed: i > 0, // Collapse overlays by default
      schemaVersion: 'IFC5',
      loadedAt: Date.now() - (layers.length - i) * 100, // Stagger timestamps
      fileSize: layerBuffer?.buffer.byteLength || 0,
      // For base layer: set proper ID range for resolveGlobalIdFromModels
      // Overlays share the same data store so they don't need their own range
      idOffset: 0,
      maxExpressId: isBaseLayer ? maxExpressId : 0,
      // Mark overlay-only layers
      _isOverlay: !isBaseLayer,
      _layerIndex: i,
    } as FederatedModel & { _isOverlay?: boolean; _layerIndex?: number };

    state.addModel(layerModel);
  }
}
