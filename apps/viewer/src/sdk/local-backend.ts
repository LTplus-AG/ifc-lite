/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LocalBackend — implements BimBackend via per-namespace adapters.
 *
 * This is the viewer's internal backend: zero serialization overhead.
 * Each namespace is a typed property with named methods.
 */

import type {
  BimBackend,
  BimEventType,
  ModelBackendMethods,
  QueryBackendMethods,
  SelectionBackendMethods,
  VisibilityBackendMethods,
  ViewerBackendMethods,
  MutateBackendMethods,
  StoreBackendMethods,
  SpatialBackendMethods,
  ExportBackendMethods,
  LensBackendMethods,
  FilesBackendMethods,
  ScheduleBackendMethods,
  StructuralBackendMethods,
  CostBackendMethods,
} from '@ifc-lite/sdk';
import type { StoreApi } from './adapters/types.js';
import { LEGACY_MODEL_ID } from './adapters/model-compat.js';
import { createModelAdapter } from './adapters/model-adapter.js';
import { createQueryAdapter } from './adapters/query-adapter.js';
import { createSelectionAdapter } from './adapters/selection-adapter.js';
import { createVisibilityAdapter } from './adapters/visibility-adapter.js';
import { createViewerAdapter } from './adapters/viewer-adapter.js';
import { createMutateAdapter } from './adapters/mutate-adapter.js';
import { createStoreAdapter } from './adapters/store-adapter.js';
import { createSpatialAdapter } from './adapters/spatial-adapter.js';
import { createLensAdapter } from './adapters/lens-adapter.js';
import { createExportAdapter } from './adapters/export-adapter.js';
import { createFilesAdapter } from './adapters/files-adapter.js';
import { createScheduleAdapter } from './adapters/schedule-adapter.js';
import { createStructuralAdapter } from './adapters/structural-adapter.js';
import { createCostAdapter } from './adapters/cost-adapter.js';
import { withBackendWriteTracking } from './adapters/backend-write-capture.js';

export class LocalBackend implements BimBackend {
  readonly model: ModelBackendMethods;
  readonly query: QueryBackendMethods;
  readonly selection: SelectionBackendMethods;
  readonly visibility: VisibilityBackendMethods;
  readonly viewer: ViewerBackendMethods;
  readonly mutate: MutateBackendMethods;
  readonly store: StoreBackendMethods;
  readonly spatial: SpatialBackendMethods;
  readonly export: ExportBackendMethods;
  readonly lens: LensBackendMethods;
  readonly files: FilesBackendMethods;
  readonly schedule: ScheduleBackendMethods;
  readonly structural: StructuralBackendMethods;
  readonly cost: CostBackendMethods;

  private storeApi: StoreApi;

  constructor(store: StoreApi) {
    this.storeApi = store;
    // Every namespace attributes the mutations its calls push to the open
    // batch / flow-run captures (#5634); the mutate adapter tracks its own.
    const tracked = <T extends object>(adapter: T): T => withBackendWriteTracking(store, adapter);
    this.model = tracked(createModelAdapter(store));
    this.query = tracked(createQueryAdapter(store));
    this.selection = tracked(createSelectionAdapter(store));
    this.visibility = tracked(createVisibilityAdapter(store));
    this.viewer = tracked(createViewerAdapter(store));
    this.mutate = createMutateAdapter(store);
    this.store = tracked(createStoreAdapter(store));
    this.spatial = tracked(createSpatialAdapter(store));
    this.lens = tracked(createLensAdapter(store));
    this.export = tracked(createExportAdapter(store));
    this.files = tracked(createFilesAdapter(store));
    this.schedule = tracked(createScheduleAdapter(store));
    this.structural = tracked(createStructuralAdapter(store));
    this.cost = tracked(createCostAdapter(store));
  }

  subscribe(event: BimEventType, handler: (data: unknown) => void): () => void {
    switch (event) {
      case 'selection:changed':
        return this.storeApi.subscribe((state, prev) => {
          if (state.selectedEntities !== prev.selectedEntities) {
            handler({ refs: state.selectedEntities ?? [] });
          }
        });

      case 'model:loaded':
        return this.storeApi.subscribe((state, prev) => {
          if (state.models.size > prev.models.size) {
            for (const [id, model] of state.models) {
              if (!prev.models.has(id)) {
                // @raw-entity-enumeration-ok model:loaded reports the initial parsed source count before session edits
                handler({
                  model: {
                    id: model.id,
                    name: model.name,
                    schema: model.schemaVersion,
                    schemaVersion: model.schemaVersion,
                    entityCount: model.ifcDataStore?.entities?.count ?? 0,
                    fileSize: model.fileSize,
                    loadedAt: model.loadedAt,
                  },
                });
              }
            }
          }
          if (state.ifcDataStore && !prev.ifcDataStore && state.models.size === 0) {
            // @raw-entity-enumeration-ok legacy model:loaded reports the initial parsed source count before session edits
            handler({
              model: {
                id: LEGACY_MODEL_ID,
                name: 'Model',
                schema: state.ifcDataStore.schemaVersion ?? 'IFC4',
                schemaVersion: state.ifcDataStore.schemaVersion ?? 'IFC4',
                entityCount: state.ifcDataStore.entities?.count ?? 0,
                fileSize: state.ifcDataStore.source?.byteLength ?? 0,
                loadedAt: 0,
              },
            });
          }
        });

      case 'model:removed':
        return this.storeApi.subscribe((state, prev) => {
          if (state.models.size < prev.models.size) {
            for (const id of prev.models.keys()) {
              if (!state.models.has(id)) {
                handler({ modelId: id });
              }
            }
          }
        });

      case 'visibility:changed':
        return this.storeApi.subscribe((state, prev) => {
          if (
            state.hiddenEntities !== prev.hiddenEntities ||
            state.isolatedEntities !== prev.isolatedEntities ||
            state.hiddenEntitiesByModel !== prev.hiddenEntitiesByModel
          ) {
            handler({});
          }
        });

      case 'mutation:changed':
        return this.storeApi.subscribe((state, prev) => {
          if (state.mutationVersion !== prev.mutationVersion) {
            handler({});
          }
        });

      case 'lens:changed':
        return this.storeApi.subscribe((state, prev) => {
          if (state.activeLensId !== prev.activeLensId) {
            handler({ lensId: state.activeLensId });
          }
        });

      default:
        return () => {};
    }
  }
}
