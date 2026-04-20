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
  SpatialBackendMethods,
  ExportBackendMethods,
  LensBackendMethods,
  FilesBackendMethods,
  ScheduleBackendMethods,
} from '@ifc-lite/sdk';
import type { StoreApi } from './adapters/types.js';
import { LEGACY_MODEL_ID } from './adapters/model-compat.js';
import { createModelAdapter } from './adapters/model-adapter.js';
import { createQueryAdapter } from './adapters/query-adapter.js';
import { createSelectionAdapter } from './adapters/selection-adapter.js';
import { createVisibilityAdapter } from './adapters/visibility-adapter.js';
import { createViewerAdapter } from './adapters/viewer-adapter.js';
import { createMutateAdapter } from './adapters/mutate-adapter.js';
import { createSpatialAdapter } from './adapters/spatial-adapter.js';
import { createLensAdapter } from './adapters/lens-adapter.js';
import { createExportAdapter } from './adapters/export-adapter.js';
import { createFilesAdapter } from './adapters/files-adapter.js';
import { createScheduleAdapter } from './adapters/schedule-adapter.js';

export class LocalBackend implements BimBackend {
  readonly model: ModelBackendMethods;
  readonly query: QueryBackendMethods;
  readonly selection: SelectionBackendMethods;
  readonly visibility: VisibilityBackendMethods;
  readonly viewer: ViewerBackendMethods;
  readonly mutate: MutateBackendMethods;
  readonly spatial: SpatialBackendMethods;
  readonly export: ExportBackendMethods;
  readonly lens: LensBackendMethods;
  readonly files: FilesBackendMethods;
  readonly schedule: ScheduleBackendMethods;

  private store: StoreApi;

  constructor(store: StoreApi) {
    this.store = store;
    this.model = createModelAdapter(store);
    this.query = createQueryAdapter(store);
    this.selection = createSelectionAdapter(store);
    this.visibility = createVisibilityAdapter(store);
    this.viewer = createViewerAdapter(store);
    this.mutate = createMutateAdapter(store);
    this.spatial = createSpatialAdapter(store);
    this.lens = createLensAdapter(store);
    this.export = createExportAdapter(store);
    this.files = createFilesAdapter(store);
    this.schedule = createScheduleAdapter(store);
  }

  subscribe(event: BimEventType, handler: (data: unknown) => void): () => void {
    switch (event) {
      case 'selection:changed':
        return this.store.subscribe((state, prev) => {
          if (state.selectedEntities !== prev.selectedEntities) {
            handler({ refs: state.selectedEntities ?? [] });
          }
        });

      case 'model:loaded':
        return this.store.subscribe((state, prev) => {
          if (state.models.size > prev.models.size) {
            for (const [id, model] of state.models) {
              if (!prev.models.has(id)) {
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
        return this.store.subscribe((state, prev) => {
          if (state.models.size < prev.models.size) {
            for (const id of prev.models.keys()) {
              if (!state.models.has(id)) {
                handler({ modelId: id });
              }
            }
          }
        });

      case 'visibility:changed':
        return this.store.subscribe((state, prev) => {
          if (
            state.hiddenEntities !== prev.hiddenEntities ||
            state.isolatedEntities !== prev.isolatedEntities ||
            state.hiddenEntitiesByModel !== prev.hiddenEntitiesByModel
          ) {
            handler({});
          }
        });

      case 'mutation:changed':
        return this.store.subscribe((state, prev) => {
          if (state.mutationVersion !== prev.mutationVersion) {
            handler({});
          }
        });

      case 'lens:changed':
        return this.store.subscribe((state, prev) => {
          if (state.activeLensId !== prev.activeLensId) {
            handler({ lensId: state.activeLensId });
          }
        });

      default:
        return () => {};
    }
  }
}
