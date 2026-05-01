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
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { EntityNode } from '@ifc-lite/query';
import { RelationshipType, IfcTypeEnum, IfcTypeEnumFromString } from '@ifc-lite/data';
import {
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractTypePropertiesOnDemand,
  extractDocumentsOnDemand,
  extractRelationshipsOnDemand,
  extractScheduleOnDemand,
} from '@ifc-lite/parser';
import { exportToStep, StepExporter, type StepExportOptions } from '@ifc-lite/export';

const REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelDefinesByType: RelationshipType.DefinesByType,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

const IFC_SUBTYPES: Record<string, string[]> = {
  IFCWALL: ['IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'],
  IFCBEAM: ['IFCBEAMSTANDARDCASE'],
  IFCCOLUMN: ['IFCCOLUMNSTANDARDCASE'],
  IFCDOOR: ['IFCDOORSTANDARDCASE'],
  IFCWINDOW: ['IFCWINDOWSTANDARDCASE'],
  IFCSLAB: ['IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE'],
  IFCMEMBER: ['IFCMEMBERSTANDARDCASE'],
  IFCPLATE: ['IFCPLATESTANDARDCASE'],
  IFCOPENINGELEMENT: ['IFCOPENINGSTANDARDCASE'],
};

export function expandTypes(types: string[]): string[] {
  const result: string[] = [];
  for (const type of types) {
    const upper = type.toUpperCase();
    result.push(upper);
    const subtypes = IFC_SUBTYPES[upper];
    if (subtypes) for (const sub of subtypes) result.push(sub);
  }
  return result;
}

export function isProductType(type: string): boolean {
  const enumVal = IfcTypeEnumFromString(type);
  if (enumVal === IfcTypeEnum.Unknown) return false;
  const upper = type.toUpperCase();
  if (upper.startsWith('IFCREL')) return false;
  if (upper.startsWith('IFCPROPERTY')) return false;
  if (upper.startsWith('IFCQUANTITY')) return false;
  if (upper === 'IFCELEMENTQUANTITY') return false;
  if (upper.endsWith('TYPE')) return false;
  return true;
}

function normalizeBoolean(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

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
    this.query = this.createQueryAdapter();
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

  private createQueryAdapter(): QueryBackendMethods {
    const store = this.dataStore;
    const id = this.modelId;

    function getEntityData(ref: EntityRef): EntityData | null {
      if (!store.entityIndex.byId.has(ref.expressId)) return null;
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
      const node = new EntityNode(store, ref.expressId);
      return node.properties().map((pset) => ({
        name: pset.name,
        globalId: pset.globalId,
        properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value })),
      }));
    }

    function getQuantities(ref: EntityRef): QuantitySetData[] {
      const node = new EntityNode(store, ref.expressId);
      return node.quantities().map((qset) => ({
        name: qset.name,
        quantities: qset.quantities.map((q) => ({ name: q.name, type: q.type, value: q.value })),
      }));
    }

    return {
      entities(descriptor: QueryDescriptor): EntityData[] {
        const results: EntityData[] = [];
        let entityIds: number[];
        if (descriptor.types && descriptor.types.length > 0) {
          entityIds = [];
          for (const type of expandTypes(descriptor.types)) {
            const typeIds = store.entityIndex.byType.get(type) ?? [];
            for (const eid of typeIds) entityIds.push(eid);
          }
        } else {
          entityIds = [];
          for (const [typeName, ids] of store.entityIndex.byType) {
            if (isProductType(typeName)) {
              for (const eid of ids) entityIds.push(eid);
            }
          }
        }
        for (const expressId of entityIds) {
          if (expressId === 0) continue;
          const node = new EntityNode(store, expressId);
          results.push({
            ref: { modelId: id, expressId },
            globalId: node.globalId,
            name: node.name,
            type: node.type,
            description: node.description,
            objectType: node.objectType,
          });
        }
        let filtered = results;
        if (descriptor.filters && descriptor.filters.length > 0) {
          const propsCache = new Map<number, PropertySetData[]>();
          const cachedProps = (ref: EntityRef): PropertySetData[] => {
            let cached = propsCache.get(ref.expressId);
            if (!cached) {
              cached = getProperties(ref);
              propsCache.set(ref.expressId, cached);
            }
            return cached;
          };
          for (const filter of descriptor.filters) {
            filtered = filtered.filter((entity) => {
              const props = cachedProps(entity.ref);
              const pset = props.find((p) => p.name === filter.psetName);
              if (!pset) return false;
              const prop = pset.properties.find((p) => p.name === filter.propName);
              if (!prop) return false;
              if (filter.operator === 'exists') return true;
              const v = normalizeBoolean(prop.value);
              const f = normalizeBoolean(filter.value);
              switch (filter.operator) {
                case '=': return String(v) === String(f);
                case '!=': return String(v) !== String(f);
                case '>': return Number(v) > Number(f);
                case '<': return Number(v) < Number(f);
                case '>=': return Number(v) >= Number(f);
                case '<=': return Number(v) <= Number(f);
                case 'contains': return String(v).toLowerCase().includes(String(f).toLowerCase());
                default: return false;
              }
            });
          }
        }
        if (descriptor.offset && descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
        if (descriptor.limit && descriptor.limit > 0) filtered = filtered.slice(0, descriptor.limit);
        return filtered;
      },
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
            properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value as string | number | boolean | null })),
          })),
        };
      },
      documents(ref: EntityRef): DocumentData[] {
        return extractDocumentsOnDemand(store, ref.expressId);
      },
      relationships(ref: EntityRef): EntityRelationshipsData {
        return extractRelationshipsOnDemand(store, ref.expressId);
      },
      related(ref: EntityRef, relType: string, direction: 'forward' | 'inverse'): EntityRef[] {
        const relEnum = REL_TYPE_MAP[relType];
        if (relEnum === undefined) return [];
        const targets = store.relationships.getRelated(ref.expressId, relEnum, direction);
        return targets.map((expressId: number) => ({ modelId: ref.modelId, expressId }));
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

  private getOrCreateStoreEditor(): StoreEditor {
    if (this.storeEditor) return this.storeEditor;
    this.mutationView = new MutablePropertyView(this.dataStore.properties || null, this.modelId);
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
      if (value.includes(sep) || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
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
