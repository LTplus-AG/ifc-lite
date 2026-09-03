/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HeadlessBackend — BimBackend implementation for CLI (no renderer).
 *
 * Wraps an IfcDataStore parsed from an IFC file and exposes it through
 * the standard BimBackend interface. Viewer-specific operations (colorize,
 * flyTo, etc.) are no-ops.
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
  SpacesBackendMethods,
  StyleBackendMethods,
  SpatialBackendMethods,
  ExportBackendMethods,
  LensBackendMethods,
  FilesBackendMethods,
  ScheduleBackendMethods,
  EntityRef,
  EntityData,
  EntityAttributeData,
  PropertySetData,
  QuantitySetData,
  ClassificationData,
  MaterialData,
  TypePropertiesData,
  DocumentData,
  EntityRelationshipsData,
  QueryDescriptor,
  ModelInfo,
} from '@ifc-lite/sdk';
import { createHeadlessMutateAdapter } from '@ifc-lite/sdk';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  addBeamToStore,
  addColumnToStore,
  addDoorToStore,
  addMemberToStore,
  addPlateToStore,
  addRoofToStore,
  applyStylesInStore,
  addSlabToStore,
  addSpaceToStore,
  addWallToStore,
  addWindowToStore,
  resolveSpatialAnchor,
  type BeamInStoreParams,
  type ColumnInStoreParams,
  type DoorInStoreParams,
  type MemberInStoreParams,
  type PlateInStoreParams,
  type RoofInStoreParams,
  type SlabInStoreParams,
  type SpaceInStoreParams,
  type WallInStoreParams,
  type WindowInStoreParams,
  generateSpaces,
  listStoreys,
  type GenerateSpacesAllOptions,
} from '@ifc-lite/create';
import { EntityNode, findPropertyInSets, findQuantityInSets, normalizeBooleanValue } from '@ifc-lite/query';

import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypePropertiesOnDemand,
  extractDocumentsOnDemand,
  extractRelationshipsOnDemand,
  expandTypes,
  QUERY_REL_TYPE_MAP,
  extractScheduleOnDemand,
  isQueryableObjectType,
} from '@ifc-lite/parser';
import { escapeCsvCell, exportToStep, StepExporter, type StepExportOptions } from '@ifc-lite/export';
import { exportHbjson, exportDfjson } from './energy-export.js';
import { foldQueuedRelated } from './query-overlay-relations.js';
import { overlayEntityData, overlayProperties, overlayQuantities, foldNewEntities } from './query-overlay.js';
import { matchesPropertyFilter } from './property-filter-match.js';

// `expandTypes` used to be defined here; it now comes from `@ifc-lite/parser`,
// shared with the other query backends (see `query-backend-maps.ts`). Re-exported
// so this module's consumers are unaffected by where it lives.
export { expandTypes };

const MODEL_ID = 'default';

/**
 * Strip a real IFC source-file extension from a filename-derived model name.
 * Only applied to the `modelName` fallback: an explicitly supplied export name
 * is a display name where a trailing dotted segment is meaningful (`Tower.v2`).
 */
function stripIfcExtension(name: string): string {
  return name.replace(/\.(ifc|ifcx|ifczip)$/i, '');
}

/**
 * Which classes an unfiltered query answers with.
 *
 * Thin alias: the predicate is schema logic and lives in `@ifc-lite/parser`, so
 * the CLI and MCP backends cannot drift apart on it. Kept as a named export
 * here because both packages already publish it under this name.
 */
export const isProductType = isQueryableObjectType;

/**
 * Normalize boolean-like values for comparison.
 * IFC STEP files store booleans as .T./.F., but users pass true/false.
 *
 * Re-exported from `@ifc-lite/query` for existing importers of this module;
 * the actual comparison the query filter runs lives there too
 * (`compareFilterValue`), shared with the viewer and MCP `QueryBackendMethods`
 * implementations so the three can't drift apart on `where()` semantics again.
 */
export { normalizeBooleanValue };

export function normalizePropertyValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (err) {
    // Cyclic structures or BigInt values that JSON.stringify can't handle —
    // log so the CLI surface is debuggable and fall back to String coercion.
    // eslint-disable-next-line no-console
    console.warn('[headless-backend] normalizePropertyValue: JSON.stringify failed', err);
    return String(value);
  }
}

export class HeadlessBackend implements BimBackend {
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
  readonly spaces: SpacesBackendMethods;
  readonly style: StyleBackendMethods;

  private dataStore: IfcDataStore;
  private modelName: string;
  private mutationView: MutablePropertyView | null = null;
  private storeEditor: StoreEditor | null = null;

  constructor(store: IfcDataStore, modelName: string) {
    this.dataStore = store;
    this.modelName = modelName;
    this.model = this.createModelAdapter();
    this.query = this.createQueryAdapter();
    this.selection = this.createSelectionAdapter();
    this.visibility = this.createVisibilityAdapter();
    this.viewer = this.createViewerAdapter();
    this.mutate = this.createMutateAdapter();
    this.store = this.createStoreAdapter();
    this.spatial = this.createSpatialAdapter();
    this.export = this.createExportAdapter();
    this.lens = this.createLensAdapter();
    this.files = this.createFilesAdapter();
    this.schedule = this.createScheduleAdapter();
    this.spaces = this.createSpacesAdapter();
    this.style = this.createStyleAdapter();
  }

  private createStyleAdapter(): StyleBackendMethods {
    return {
      // Same arrangement as the spaces adapter: the work happens in
      // @ifc-lite/create against the shared StoreEditor, so the new entities
      // land in the overlay this backend's export adapter already reads.
      applyColors: (batches, options) => applyStylesInStore(
        this.getOrCreateStoreEditor(),
        this.dataStore,
        batches.map(batch => ({
          products: batch.refs.map(r => r.expressId),
          color: batch.color,
          name: batch.name,
        })),
        options,
      ),
    };
  }

  private createSpacesAdapter(): SpacesBackendMethods {
    return {
      listStoreys: () => listStoreys(this.dataStore),
      // Spaces are written via the shared StoreEditor/MutablePropertyView, so
      // they're picked up by this backend's export adapter (StepExporter).
      generate: (options?: GenerateSpacesAllOptions) =>
        generateSpaces(this.getOrCreateStoreEditor(), this.dataStore, options),
    };
  }

  subscribe(_event: BimEventType, _handler: (data: unknown) => void): () => void {
    return () => {};
  }

  private createModelAdapter(): ModelBackendMethods {
    const store = this.dataStore;
    const name = this.modelName;
    return {
      list(): ModelInfo[] {
        return [{
          id: MODEL_ID,
          name,
          schema: store.schemaVersion,
          schemaVersion: store.schemaVersion,
          entityCount: store.entityCount,
          fileSize: store.fileSize,
          loadedAt: Date.now(),
        }];
      },
      activeId() { return MODEL_ID; },
      loadIfc() { /* no-op in headless mode */ },
    };
  }

  private createQueryAdapter(): QueryBackendMethods {
    const store = this.dataStore;
    // Lazy — a read-only session's `related()` stays on the store-only path.
    const getMutationView = () => this.mutationView;

    function getEntityData(ref: EntityRef): EntityData | null {
      const overlay = overlayEntityData(getMutationView(), ref);
      if (overlay !== undefined) return overlay;
      if (!store.entityIndex.byId.has(ref.expressId)) return null; // not parsed either
      const node = new EntityNode(store, ref.expressId);
      const type = node.type;
      if (!type || type === 'Unknown') return null;
      return {
        ref,
        globalId: node.globalId,
        name: node.name,
        type,
        description: node.description,
        objectType: node.objectType,
      };
    }

    function getProperties(ref: EntityRef): PropertySetData[] {
      const overlay = overlayProperties(getMutationView(), ref);
      if (overlay !== undefined) return overlay;
      const node = new EntityNode(store, ref.expressId);
      return node.properties().map((pset) => ({
        name: pset.name,
        globalId: pset.globalId,
        properties: pset.properties.map((p) => ({
          name: p.name,
          type: p.type,
          value: p.value as string | number | boolean | null,
        })),
      }));
    }

    function getQuantities(ref: EntityRef): QuantitySetData[] {
      const overlay = overlayQuantities(getMutationView(), ref);
      if (overlay !== undefined) return overlay;
      const node = new EntityNode(store, ref.expressId);
      return node.quantities().map(qset => ({
        name: qset.name,
        quantities: qset.quantities.map(q => ({
          name: q.name,
          type: q.type,
          value: q.value,
        })),
      }));
    }

    return {
      entities(descriptor: QueryDescriptor): EntityData[] {
        const results: EntityData[] = [];
        const view = getMutationView();

        let entityIds: number[];
        if (descriptor.types && descriptor.types.length > 0) {
          entityIds = [];
          for (const type of expandTypes(descriptor.types)) {
            const typeIds = store.entityIndex.byType.get(type) ?? [];
            for (const id of typeIds) entityIds.push(id);
          }
        } else {
          entityIds = [];
          for (const [typeName, ids] of store.entityIndex.byType) {
            if (isProductType(typeName)) {
              for (const id of ids) entityIds.push(id);
            }
          }
        }

        for (const expressId of entityIds) {
          if (expressId === 0) continue;
          if (view?.isDeleted(expressId)) continue; // tombstoned this session
          const node = new EntityNode(store, expressId);
          results.push({
            ref: { modelId: MODEL_ID, expressId },
            globalId: node.globalId,
            name: node.name,
            type: node.type,
            description: node.description,
            objectType: node.objectType,
          });
        }
        if (view) results.push(...foldNewEntities(view, descriptor.types, expandTypes, isProductType, MODEL_ID));
        let filtered = results;
        if (descriptor.filters && descriptor.filters.length > 0) {
          const propsCache = new Map<number, PropertySetData[]>();
          const getCachedProps = (ref: EntityRef): PropertySetData[] => {
            let cached = propsCache.get(ref.expressId);
            if (!cached) {
              cached = getProperties(ref);
              propsCache.set(ref.expressId, cached);
            }
            return cached;
          };

          for (const filter of descriptor.filters) {
            filtered = filtered.filter(entity => {
              const props = getCachedProps(entity.ref);
              return matchesPropertyFilter(props, filter);
            });
          }
        }

        // `!= null` alone lets a NaN offset/limit through (neither null nor
        // undefined); a bare `> 0` then silently drops it (every NaN
        // comparison is false) instead of rejecting it, and by the same
        // reasoning silently ignored a deliberate `limit: 0`. Reject
        // non-finite/negative values loudly instead of quietly serving the
        // wrong slice. The CLI's own `--limit`/`--offset` flags are validated
        // before reaching this descriptor, so this guards direct SDK callers
        // (`@ifc-lite/mcp`'s parallel `backend-query.ts` ported the identical
        // fix independently — same defect shape, own tests and release
        // cadence).
        if (descriptor.offset != null) {
          if (!Number.isFinite(descriptor.offset) || descriptor.offset < 0) {
            throw new TypeError(`Invalid offset: ${descriptor.offset} (must be a non-negative finite number)`);
          }
          if (descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
        }
        if (descriptor.limit != null) {
          if (!Number.isFinite(descriptor.limit) || descriptor.limit < 0) {
            throw new TypeError(`Invalid limit: ${descriptor.limit} (must be a non-negative finite number)`);
          }
          filtered = filtered.slice(0, descriptor.limit);
        }

        return filtered;
      },
      // Headless contexts have no interactive viewer filter, so there is never
      // an "active filter" to report (issue #1107).
      entitiesMatchingActiveFilter: () => null,
      entityData: getEntityData,
      attributes(ref: EntityRef): EntityAttributeData[] {
        return extractAllEntityAttributes(store, ref.expressId);
      },
      properties: getProperties,
      quantities: getQuantities,
      classifications(ref: EntityRef): ClassificationData[] {
        return extractClassificationsOnDemand(store, ref.expressId);
      },
      materials(ref: EntityRef): MaterialData | null {
        return extractMaterialsOnDemand(store, ref.expressId);
      },
      typeProperties(ref: EntityRef): TypePropertiesData | null {
        const info = extractTypePropertiesOnDemand(store, ref.expressId);
        if (!info) return null;
        return {
          typeName: info.typeName,
          typeId: info.typeId,
          properties: info.properties.map((pset) => ({
            name: pset.name,
            globalId: pset.globalId,
            properties: pset.properties.map((prop) => ({
              name: prop.name,
              type: prop.type,
              value: normalizePropertyValue(prop.value),
            })),
          })),
        };
      },
      documents(ref: EntityRef): DocumentData[] {
        return extractDocumentsOnDemand(store, ref.expressId);
      },
      relationships(ref: EntityRef): EntityRelationshipsData {
        return extractRelationshipsOnDemand(store, ref.expressId);
      },
      // Folds queued `IfcRel…` creates in (query-overlay-relations.ts, mirrors #2014).
      related(ref: EntityRef, relType: string, direction: 'forward' | 'inverse'): EntityRef[] {
        const relEnum = QUERY_REL_TYPE_MAP[relType];
        if (relEnum === undefined) return [];
        const view = getMutationView();
        if (view?.isDeleted(ref.expressId)) return []; // deleted relates to nothing
        const half = direction === 'forward' ? store.relationships.forward : store.relationships.inverse;
        const out: number[] = [];
        const seen = new Set<number>();
        const take = (id: number): void => {
          if (view?.isDeleted(id) || seen.has(id)) return;
          seen.add(id);
          out.push(id);
        };
        for (const edge of half.getEdges(ref.expressId, relEnum)) {
          if (!view?.isDeleted(edge.relationshipId)) take(edge.target);
        }
        if (view) for (const t of foldQueuedRelated(view.getNewEntities(), (id) => view.isDeleted(id), relType, direction, ref.expressId)) take(t);
        return out.map((expressId: number) => ({ modelId: ref.modelId, expressId }));
      },
    };
  }

  private createSelectionAdapter(): SelectionBackendMethods {
    let selection: EntityRef[] = [];
    return {
      get() { return selection; },
      set(refs: EntityRef[]) { selection = refs; },
    };
  }

  private createVisibilityAdapter(): VisibilityBackendMethods {
    return {
      hide() { /* no-op */ },
      show() { /* no-op */ },
      isolate() { /* no-op */ },
      reset() { /* no-op */ },
    };
  }

  private createViewerAdapter(): ViewerBackendMethods {
    return {
      colorize() { /* no-op */ },
      colorizeAll() { /* no-op */ },
      resetColors() { /* no-op */ },
      flyTo() { /* no-op */ },
      setSection() { /* no-op */ },
      getSection() { return null; },
      setCamera() { /* no-op */ },
      getCamera() { return { mode: 'perspective' as const }; },
    };
  }

  private createMutateAdapter(): MutateBackendMethods {
    return createHeadlessMutateAdapter(() => this.getOrCreateMutationView());
  }

  /**
   * The overlay every write goes through, created on first use by
   * `getOrCreateStoreEditor` so its extractors are wired exactly once.
   */
  private getOrCreateMutationView(): MutablePropertyView {
    this.getOrCreateStoreEditor();
    // Non-null immediately after: both fields are assigned together and never cleared.
    return this.mutationView as MutablePropertyView;
  }

  private getOrCreateStoreEditor(): StoreEditor {
    if (this.storeEditor) return this.storeEditor;
    this.mutationView = new MutablePropertyView(this.dataStore.properties || null, MODEL_ID);
    // Give the overlay a base to merge against — the columnar parser serves
    // properties on demand, so without this `getForEntity` would answer with
    // only the one edited pset and `StepExporter` would drop every sibling
    // property on save. Same wiring as `packages/mcp/src/headless-backend.ts`
    // and `apps/viewer/src/utils/configureMutationView.ts` (#2000, #2004).
    if (this.dataStore.source?.length > 0) {
      this.mutationView.setOnDemandExtractor((entityId) => extractPropertiesOnDemand(this.dataStore, entityId));
      this.mutationView.setQuantityExtractor((entityId) => extractQuantitiesOnDemand(this.dataStore, entityId));
    }
    this.storeEditor = new StoreEditor(this.dataStore, this.mutationView);
    return this.storeEditor;
  }

  private createStoreAdapter(): StoreBackendMethods {
    const get = () => this.getOrCreateStoreEditor();
    const dataStore = () => this.dataStore;
    return {
      addEntity(modelId: string, def: { type: string; attributes: unknown[] }): EntityRef {
        const ref = get().addEntity(def.type, def.attributes as Parameters<StoreEditor['addEntity']>[1]);
        return { modelId, expressId: ref.expressId };
      },
      removeEntity(ref: EntityRef): boolean {
        return get().removeEntity(ref.expressId);
      },
      setPositionalAttribute(ref: EntityRef, index: number, value: unknown): void {
        get().setPositionalAttribute(ref.expressId, index, value as Parameters<StoreEditor['setPositionalAttribute']>[2]);
      },
      addColumn(modelId: string, storeyExpressId: number, params: ColumnInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addColumnToStore(editor, anchor, params);
        return { modelId, expressId: result.columnId };
      },
      addWall(modelId: string, storeyExpressId: number, params: WallInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addWallToStore(editor, anchor, params);
        return { modelId, expressId: result.wallId };
      },
      addSlab(modelId: string, storeyExpressId: number, params: SlabInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addSlabToStore(editor, anchor, params);
        return { modelId, expressId: result.slabId };
      },
      addBeam(modelId: string, storeyExpressId: number, params: BeamInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addBeamToStore(editor, anchor, params);
        return { modelId, expressId: result.beamId };
      },
      addDoor(modelId: string, storeyExpressId: number, params: DoorInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addDoorToStore(editor, anchor, params);
        return { modelId, expressId: result.doorId };
      },
      addWindow(modelId: string, storeyExpressId: number, params: WindowInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addWindowToStore(editor, anchor, params);
        return { modelId, expressId: result.windowId };
      },
      addSpace(modelId: string, storeyExpressId: number, params: SpaceInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addSpaceToStore(editor, anchor, params);
        return { modelId, expressId: result.spaceId };
      },
      addRoof(modelId: string, storeyExpressId: number, params: RoofInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addRoofToStore(editor, anchor, params);
        return { modelId, expressId: result.roofId };
      },
      addPlate(modelId: string, storeyExpressId: number, params: PlateInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addPlateToStore(editor, anchor, params);
        return { modelId, expressId: result.plateId };
      },
      addMember(modelId: string, storeyExpressId: number, params: MemberInStoreParams): EntityRef {
        const editor = get();
        const anchor = resolveSpatialAnchor(dataStore(), storeyExpressId);
        const result = addMemberToStore(editor, anchor, params);
        return { modelId, expressId: result.memberId };
      },
    };
  }

  private createSpatialAdapter(): SpatialBackendMethods {
    return {
      queryBounds() { return []; },
      raycast() { return []; },
      queryFrustum() { return []; },
    };
  }

  private createExportAdapter(): ExportBackendMethods {
    const store = this.dataStore;
    const modelName = this.modelName;
    const queryAdapter = this.query;

    /**
     * RFC 4180 quoting + the CWE-1236 formula-injection guard, delegated to
     * `@ifc-lite/export`'s single escaper. The copy that used to live here
     * tested the trigger anchored at offset 0, so a BOM/ZWSP/LRM/NBSP/U+2028
     * in front of `=` walked past it.
     */
    function escapeCsv(value: string, sep: string): string {
      return escapeCsvCell(value, { delimiter: sep });
    }

    function resolveColumn(data: EntityData, col: string, props: PropertySetData[] | null, qsets: QuantitySetData[] | null): string {
      if (col === 'Name' || col === 'name') return data.name;
      if (col === 'Type' || col === 'type') return data.type;
      if (col === 'GlobalId' || col === 'globalId') return data.globalId;
      if (col === 'Description' || col === 'description') return data.description;
      if (col === 'ObjectType' || col === 'objectType') return data.objectType;

      const dotIdx = col.indexOf('.');
      if (dotIdx > 0) {
        const setName = col.slice(0, dotIdx);
        const valueName = col.slice(dotIdx + 1);
        if (props) {
          const prop = findPropertyInSets(props, setName, valueName);
          if (prop?.value != null) return String(prop.value);
        }
        if (qsets) {
          const qty = findQuantityInSets(qsets, setName, valueName);
          if (qty?.value != null) return String(qty.value);
        }
      }
      return '';
    }

    return {
      csv(refs: unknown, options: unknown): string {
        const entityRefs = refs as EntityRef[];
        const opts = options as { columns: string[]; separator?: string };
        const columns = opts.columns;
        const sep = opts.separator ?? ',';
        const hasDotColumns = columns.some(c => c.indexOf('.') > 0);
        const rows: string[][] = [columns];

        for (const ref of entityRefs) {
          const data = queryAdapter.entityData(ref);
          if (!data) continue;
          const props = hasDotColumns ? queryAdapter.properties(ref) : null;
          const qsets = hasDotColumns ? queryAdapter.quantities(ref) : null;
          rows.push(columns.map(col => resolveColumn(data, col, props, qsets)));
        }

        return rows.map(r => r.map(cell => escapeCsv(cell, sep)).join(sep)).join('\n');
      },
      json(refs: unknown, columns: unknown): Record<string, unknown>[] {
        const entityRefs = refs as EntityRef[];
        const cols = columns as string[];
        const hasDotColumns = cols.some(c => c.indexOf('.') > 0);
        const result: Record<string, unknown>[] = [];

        for (const ref of entityRefs) {
          const data = queryAdapter.entityData(ref);
          if (!data) continue;
          const props = hasDotColumns ? queryAdapter.properties(ref) : null;
          const qsets = hasDotColumns ? queryAdapter.quantities(ref) : null;
          const row: Record<string, unknown> = {};
          for (const col of cols) {
            const val = resolveColumn(data, col, props, qsets);
            row[col] = val || null;
          }
          result.push(row);
        }
        return result;
      },
      ifc: (refs: unknown, options: unknown): string => {
        const entityRefs = refs as EntityRef[];
        const opts = (options ?? {}) as Record<string, unknown>;
        const schema = (opts.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3') ?? store.schemaVersion ?? 'IFC4';

        const exportOpts: Partial<StepExportOptions> = { schema };
        if (entityRefs && entityRefs.length > 0) {
          const isolatedIds = new Set(entityRefs.map(r => r.expressId));
          exportOpts.visibleOnly = true;
          exportOpts.isolatedEntityIds = isolatedIds;
          exportOpts.hiddenEntityIds = new Set<number>();
        }
        // Route through StepExporter directly so any bim.store.* / bim.mutate.*
        // overlay state on this backend's MutablePropertyView is included.
        if (this.mutationView) {
          const exporter = new StepExporter(store, this.mutationView);
          const result = exporter.export({ schema, ...exportOpts });
          return new TextDecoder().decode(result.content);
        }
        return exportToStep(store, exportOpts);
      },
      // Both energy formats apply the mutation view — see energy-export.ts
      // (issues #1908, #1344). An explicit `name` is a display/model name, so
      // it is kept verbatim (dotted identifiers like `Tower.v2` are valid);
      // only the `modelName` fallback is a filename, so only it gets a real
      // IFC extension stripped.
      hbjson: (name?: string): Promise<string> =>
        exportHbjson(store, this.mutationView, name ?? stripIfcExtension(modelName)),
      dfjson: (name?: string): Promise<string> =>
        exportDfjson(store, this.mutationView, name ?? stripIfcExtension(modelName)),
      download(_content: string, _filename: string, _mimeType: string): void {
        /* no-op — CLI writes to stdout/file directly */
      },
    };
  }

  private createLensAdapter(): LensBackendMethods {
    return {
      presets() { return []; },
      create() { return null; },
      activate() { /* no-op */ },
      deactivate() { /* no-op */ },
      getActive() { return null; },
    };
  }

  private createFilesAdapter(): FilesBackendMethods {
    return {
      list() { return []; },
      text() { return null; },
      csv() { return null; },
      csvColumns() { return []; },
    };
  }

  private createScheduleAdapter(): ScheduleBackendMethods {
    const store = this.dataStore;
    const modelName = this.modelName;
    let cached: ReturnType<ScheduleBackendMethods['data']> | null = null;

    const assertModel = (modelId?: string) => {
      // Headless mode ships exactly one model — `MODEL_ID` or the configured
      // name. Unknown ids surface a clear error instead of silently returning
      // the wrong data.
      if (modelId && modelId !== MODEL_ID && modelId !== modelName) {
        throw new Error(
          `Unknown modelId '${modelId}' — headless backend only has '${MODEL_ID}'`,
        );
      }
    };

    const extract = (modelId?: string) => {
      assertModel(modelId);
      if (!cached) {
        cached = extractScheduleOnDemand(store) as ReturnType<ScheduleBackendMethods['data']>;
      }
      return cached;
    };

    return {
      data: (modelId) => extract(modelId),
      tasks: (modelId) => extract(modelId).tasks,
      workSchedules: (modelId) => extract(modelId).workSchedules,
      sequences: (modelId) => extract(modelId).sequences,
    };
  }
}
