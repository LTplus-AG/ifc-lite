/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HeadlessLikeBackend — minimal `BimBackend` for MCP tool execution.
 *
 * Mirrors `@ifc-lite/cli`'s HeadlessBackend but trimmed to the surface MCP
 * tools touch (model + query + selection + spatial + export + mutate +
 * store + visibility + viewer no-ops). Splitting it out of the CLI lets the
 * MCP package avoid the `@ifc-lite/viewer-core` dependency that the CLI
 * pulls in for `ifc-lite view`.
 *
 * Tools that need richer functionality (geometry mesh data, raycast,
 * heatmap evaluation) call the parser directly via the registry's
 * `LoadedModel.store`, not through this backend.
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
  EntityRef,
  EntityData,
  PropertySetData,
  QuantitySetData,
  ModelInfo,
} from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractScheduleOnDemand,
} from '@ifc-lite/parser';
import { exportToStep, StepExporter, type StepExportOptions } from '@ifc-lite/export';
import { createQueryAdapter } from './backend-query.js';
import { overlayFromView, type PendingOverlay } from './overlay.js';

export { expandTypes, isProductType } from './backend-query.js';

export class HeadlessLikeBackend implements BimBackend {
  readonly model: ModelBackendMethods;
  readonly query: QueryBackendMethods;
  readonly selection: SelectionBackendMethods;
  /**
   * Mutable so the MCP server can swap in streaming adapters when the
   * viewer subprocess starts, then revert when it closes. Marked
   * `readonly` on the BimBackend interface but the underlying instance
   * is ours to manage.
   */
  visibility: VisibilityBackendMethods;
  viewer: ViewerBackendMethods;
  readonly mutate: MutateBackendMethods;
  readonly store: StoreBackendMethods;
  readonly spatial: SpatialBackendMethods;
  readonly export: ExportBackendMethods;
  readonly lens: LensBackendMethods;
  readonly files: FilesBackendMethods;
  readonly schedule: ScheduleBackendMethods;

  private dataStore: IfcDataStore;
  private modelName: string;
  private modelId: string;
  private mutationView: MutablePropertyView | null = null;
  private storeEditor: StoreEditor | null = null;

  constructor(store: IfcDataStore, modelName: string, modelId: string) {
    this.dataStore = store;
    this.modelName = modelName;
    this.modelId = modelId;
    this.model = this.createModelAdapter();
    // The read surface folds this session's queued mutations in (#2004). The
    // overlay is passed as a getter because it is built lazily on the first
    // mutation, so a session that is only ever read stays on the store-only
    // path and pays nothing.
    this.query = createQueryAdapter(store, modelId, () => this.pendingOverlay());
    this.selection = this.createSelectionAdapter();
    this.visibility = { hide() {}, show() {}, isolate() {}, reset() {} };
    this.viewer = {
      colorize() {}, colorizeAll() {}, resetColors() {},
      flyTo() {}, setSection() {}, getSection() { return null; },
      setCamera() {}, getCamera() { return { mode: 'perspective' as const }; },
    };
    this.mutate = {
      setProperty() {}, setAttribute() {}, deleteProperty() {},
      batchBegin() {}, batchEnd() {}, undo() { return false; }, redo() { return false; },
    };
    this.store = this.createStoreAdapter();
    this.spatial = { queryBounds() { return []; }, raycast() { return []; }, queryFrustum() { return []; } };
    this.export = this.createExportAdapter();
    this.lens = { presets() { return []; }, create() { return null; }, activate() {}, deactivate() {}, getActive() { return null; } };
    this.files = { list() { return []; }, text() { return null; }, csv() { return null; }, csvColumns() { return []; } };
    this.schedule = this.createScheduleAdapter();
  }

  subscribe(_event: BimEventType, _handler: (data: unknown) => void): () => void {
    return () => {};
  }

  private createModelAdapter(): ModelBackendMethods {
    const store = this.dataStore;
    const name = this.modelName;
    const id = this.modelId;
    return {
      list(): ModelInfo[] {
        return [{
          id,
          name,
          schema: store.schemaVersion,
          schemaVersion: store.schemaVersion,
          entityCount: store.entityCount,
          fileSize: store.fileSize,
          loadedAt: Date.now(),
        }];
      },
      activeId() { return id; },
      loadIfc() { /* no-op in headless */ },
    };
  }

  /** This session's queued edits, or null when it has none. */
  pendingOverlay(): PendingOverlay | null {
    return overlayFromView(this.mutationView);
  }

  private createSelectionAdapter(): SelectionBackendMethods {
    let selection: EntityRef[] = [];
    return {
      get() { return selection; },
      set(refs: EntityRef[]) { selection = refs; },
    };
  }

  private getOrCreateStoreEditor(): StoreEditor {
    if (this.storeEditor) return this.storeEditor;
    this.mutationView = new MutablePropertyView(this.dataStore.properties || null, this.modelId);
    // Give the overlay a base to merge against. The columnar parser leaves
    // `store.properties` empty and serves properties on demand, so without
    // these the view's *only* source is the overlay itself: `getForEntity`
    // answers with the one edited pset and nothing else. That is not a
    // cosmetic gap — `StepExporter` re-emits `getForEntity(id)` for every
    // entity with a property mutation and skips the original records, so
    // editing one property dropped every sibling property in that pset on
    // save. Mirrors `apps/viewer/src/utils/configureMutationView.ts` minus its
    // `extractTypeEntityOwnProperties` branch: the same plain extractor is what
    // `diff-fingerprints.ts` hashes, and the two must read one base.
    if (this.dataStore.source?.length > 0) {
      this.mutationView.setOnDemandExtractor((entityId) => extractPropertiesOnDemand(this.dataStore, entityId));
      this.mutationView.setQuantityExtractor((entityId) => extractQuantitiesOnDemand(this.dataStore, entityId));
    }
    this.storeEditor = new StoreEditor(this.dataStore, this.mutationView);
    return this.storeEditor;
  }

  /** Expose the mutation view so tools can inspect pending mutations. */
  getMutationView(): MutablePropertyView | null {
    return this.mutationView;
  }

  /** Force creation of the editor (used by mutation tools that always need it). */
  ensureEditor(): StoreEditor {
    return this.getOrCreateStoreEditor();
  }

  /** Replace the viewer/visibility adapters at runtime (for ViewerManager). */
  attachStreamingAdapters(viewer: ViewerBackendMethods, visibility: VisibilityBackendMethods): void {
    this.viewer = viewer;
    this.visibility = visibility;
  }

  /** Restore no-op viewer/visibility adapters (for ViewerManager close). */
  detachStreamingAdapters(): void {
    this.viewer = {
      colorize() {}, colorizeAll() {}, resetColors() {},
      flyTo() {}, setSection() {}, getSection() { return null; },
      setCamera() {}, getCamera() { return { mode: 'perspective' as const }; },
    };
    this.visibility = { hide() {}, show() {}, isolate() {}, reset() {} };
  }

  private createStoreAdapter(): StoreBackendMethods {
    const get = () => this.getOrCreateStoreEditor();
    return {
      addEntity: (modelId, def) => {
        const ref = get().addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
        return { modelId, expressId: ref.expressId };
      },
      removeEntity: (ref) => get().removeEntity(ref.expressId),
      setPositionalAttribute: (ref, index, value) => {
        get().setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
      },
      // The element-creation helpers (addWall, addSlab, …) are not used by the
      // MCP server in v0.1 — agent flows go through entity_create with raw
      // attributes. Stubs throw so a misconfigured caller fails loudly.
      addColumn: () => { throw new Error('addColumn not supported in MCP v0.1; use entity_create'); },
      addWall: () => { throw new Error('addWall not supported in MCP v0.1; use entity_create'); },
      addSlab: () => { throw new Error('addSlab not supported in MCP v0.1; use entity_create'); },
      addBeam: () => { throw new Error('addBeam not supported in MCP v0.1; use entity_create'); },
      addDoor: () => { throw new Error('addDoor not supported in MCP v0.1; use entity_create'); },
      addWindow: () => { throw new Error('addWindow not supported in MCP v0.1; use entity_create'); },
      addSpace: () => { throw new Error('addSpace not supported in MCP v0.1; use entity_create'); },
      addRoof: () => { throw new Error('addRoof not supported in MCP v0.1; use entity_create'); },
      addPlate: () => { throw new Error('addPlate not supported in MCP v0.1; use entity_create'); },
      addMember: () => { throw new Error('addMember not supported in MCP v0.1; use entity_create'); },
    };
  }

  private createExportAdapter(): ExportBackendMethods {
    const store = this.dataStore;
    const queryAdapter = this.query;

    const escapeCsv = (value: string, sep: string): string => {
      // CSV/formula-injection guard (CWE-1236): prefix a leading spreadsheet
      // formula trigger so Excel/Sheets treat the cell as text, not a formula.
      let str = value;
      if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
      }
      if (str.includes(sep) || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const resolveColumn = (
      data: EntityData,
      col: string,
      props: PropertySetData[] | null,
      qsets: QuantitySetData[] | null,
    ): string => {
      if (col === 'Name' || col === 'name') return data.name;
      if (col === 'Type' || col === 'type') return data.type;
      if (col === 'GlobalId' || col === 'globalId') return data.globalId;
      if (col === 'Description' || col === 'description') return data.description;
      if (col === 'ObjectType' || col === 'objectType') return data.objectType;
      const dot = col.indexOf('.');
      if (dot > 0) {
        const setName = col.slice(0, dot);
        const valueName = col.slice(dot + 1);
        if (props) {
          const pset = props.find((p) => p.name === setName);
          if (pset) {
            const prop = pset.properties.find((p) => p.name === valueName);
            if (prop?.value != null) return String(prop.value);
          }
        }
        if (qsets) {
          const qset = qsets.find((q) => q.name === setName);
          if (qset) {
            const qty = qset.quantities.find((q) => q.name === valueName);
            if (qty?.value != null) return String(qty.value);
          }
        }
      }
      return '';
    };

    return {
      csv(refs, options): string {
        const entityRefs = refs as EntityRef[];
        const opts = options as { columns: string[]; separator?: string };
        const sep = opts.separator ?? ',';
        const hasDot = opts.columns.some((c) => c.indexOf('.') > 0);
        const rows: string[][] = [opts.columns];
        for (const ref of entityRefs) {
          const data = queryAdapter.entityData(ref);
          if (!data) continue;
          const props = hasDot ? queryAdapter.properties(ref) : null;
          const qsets = hasDot ? queryAdapter.quantities(ref) : null;
          rows.push(opts.columns.map((c) => resolveColumn(data, c, props, qsets)));
        }
        return rows.map((r) => r.map((c) => escapeCsv(c, sep)).join(sep)).join('\n');
      },
      json(refs, columns): Record<string, unknown>[] {
        const entityRefs = refs as EntityRef[];
        const cols = columns as string[];
        const hasDot = cols.some((c) => c.indexOf('.') > 0);
        const result: Record<string, unknown>[] = [];
        for (const ref of entityRefs) {
          const data = queryAdapter.entityData(ref);
          if (!data) continue;
          const props = hasDot ? queryAdapter.properties(ref) : null;
          const qsets = hasDot ? queryAdapter.quantities(ref) : null;
          const row: Record<string, unknown> = {};
          for (const col of cols) {
            const v = resolveColumn(data, col, props, qsets);
            row[col] = v || null;
          }
          result.push(row);
        }
        return result;
      },
      ifc: (refs, options): string => {
        const entityRefs = refs as EntityRef[];
        const opts = (options ?? {}) as Record<string, unknown>;
        const schema = (opts.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3') ?? store.schemaVersion ?? 'IFC4';
        const exportOpts: Partial<StepExportOptions> = { schema };
        if (entityRefs && entityRefs.length > 0) {
          const isolatedIds = new Set(entityRefs.map((r) => r.expressId));
          exportOpts.visibleOnly = true;
          exportOpts.isolatedEntityIds = isolatedIds;
          exportOpts.hiddenEntityIds = new Set<number>();
        }
        if (this.mutationView) {
          const exporter = new StepExporter(store, this.mutationView);
          const result = exporter.export({ schema, ...exportOpts });
          return new TextDecoder().decode(result.content);
        }
        return exportToStep(store, exportOpts);
      },
      download(): void { /* CLI / MCP write to disk via tools, not the SDK download path */ },
    };
  }

  private createScheduleAdapter(): ScheduleBackendMethods {
    const store = this.dataStore;
    const id = this.modelId;
    let cached: ReturnType<ScheduleBackendMethods['data']> | null = null;
    const assert = (modelId?: string): void => {
      if (modelId && modelId !== id) {
        throw new Error(`Unknown modelId '${modelId}' — this backend only has '${id}'`);
      }
    };
    const extract = (modelId?: string): ReturnType<ScheduleBackendMethods['data']> => {
      assert(modelId);
      if (!cached) cached = extractScheduleOnDemand(store) as ReturnType<ScheduleBackendMethods['data']>;
      return cached;
    };
    return {
      data: (m) => extract(m),
      tasks: (m) => extract(m).tasks,
      workSchedules: (m) => extract(m).workSchedules,
      sequences: (m) => extract(m).sequences,
    };
  }
}
