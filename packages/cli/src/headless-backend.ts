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
import { exportToStep, type StepExportOptions } from '@ifc-lite/export';

const MODEL_ID = 'default';

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
    if (subtypes) {
      for (const sub of subtypes) result.push(sub);
    }
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

/**
 * Normalize boolean-like values for comparison.
 * IFC STEP files store booleans as .T./.F., but users pass true/false.
 */
export function normalizeBooleanValue(value: unknown): unknown {
  if (value === true || value === '.T.' || value === 'true' || value === 'TRUE') return 'true';
  if (value === false || value === '.F.' || value === 'false' || value === 'FALSE') return 'false';
  return value;
}

export function normalizePropertyValue(value: unknown): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
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
  readonly spatial: SpatialBackendMethods;
  readonly export: ExportBackendMethods;
  readonly lens: LensBackendMethods;
  readonly files: FilesBackendMethods;
  readonly schedule: ScheduleBackendMethods;

  private store: IfcDataStore;
  private modelName: string;

  constructor(store: IfcDataStore, modelName: string) {
    this.store = store;
    this.modelName = modelName;
    this.model = this.createModelAdapter();
    this.query = this.createQueryAdapter();
    this.selection = this.createSelectionAdapter();
    this.visibility = this.createVisibilityAdapter();
    this.viewer = this.createViewerAdapter();
    this.mutate = this.createMutateAdapter();
    this.spatial = this.createSpatialAdapter();
    this.export = this.createExportAdapter();
    this.lens = this.createLensAdapter();
    this.files = this.createFilesAdapter();
    this.schedule = this.createScheduleAdapter();
  }

  subscribe(_event: BimEventType, _handler: (data: unknown) => void): () => void {
    return () => {};
  }

  private createModelAdapter(): ModelBackendMethods {
    const store = this.store;
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
    const store = this.store;

    function getEntityData(ref: EntityRef): EntityData | null {
      // Verify the entity actually exists in the parsed data
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
        properties: pset.properties.map((p) => ({
          name: p.name,
          type: p.type,
          value: p.value,
        })),
      }));
    }

    function getQuantities(ref: EntityRef): QuantitySetData[] {
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
              const pset = props.find(p => p.name === filter.psetName);
              if (!pset) return false;
              const prop = pset.properties.find(p => p.name === filter.propName);
              if (!prop) return false;
              if (filter.operator === 'exists') return true;
              const val = prop.value;
              const filterVal = filter.value;
              // Normalize booleans: .T./.F./true/false all compare equally
              const normVal = normalizeBooleanValue(val);
              const normFilterVal = normalizeBooleanValue(filterVal);
              switch (filter.operator) {
                case '=': return String(normVal) === String(normFilterVal);
                case '!=': return String(normVal) !== String(normFilterVal);
                case '>': return Number(normVal) > Number(normFilterVal);
                case '<': return Number(normVal) < Number(normFilterVal);
                case '>=': return Number(normVal) >= Number(normFilterVal);
                case '<=': return Number(normVal) <= Number(normFilterVal);
                case 'contains': return String(normVal).toLowerCase().includes(String(normFilterVal).toLowerCase());
                default: return false;
              }
            });
          }
        }

        if (descriptor.offset != null && descriptor.offset > 0) filtered = filtered.slice(descriptor.offset);
        if (descriptor.limit != null && descriptor.limit > 0) filtered = filtered.slice(0, descriptor.limit);

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
    return {
      setProperty() { /* no-op in headless mode */ },
      setAttribute() { /* no-op in headless mode */ },
      deleteProperty() { /* no-op in headless mode */ },
      batchBegin() { /* no-op */ },
      batchEnd() { /* no-op */ },
      undo() { return false; },
      redo() { return false; },
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
    const store = this.store;
    const queryAdapter = this.query;

    function escapeCsv(value: string, sep: string): string {
      if (value.includes(sep) || value.includes('"') || value.includes('\n')) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
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
          const pset = props.find(p => p.name === setName);
          if (pset) {
            const prop = pset.properties.find(p => p.name === valueName);
            if (prop?.value != null) return String(prop.value);
          }
        }
        if (qsets) {
          const qset = qsets.find(q => q.name === setName);
          if (qset) {
            const qty = qset.quantities.find(q => q.name === valueName);
            if (qty?.value != null) return String(qty.value);
          }
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
      ifc(refs: unknown, options: unknown): string {
        const entityRefs = refs as EntityRef[];
        const opts = (options ?? {}) as Record<string, unknown>;
        const schema = (opts.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3') ?? store.schemaVersion ?? 'IFC4';

        // If refs are provided, filter export to only those entities
        const exportOpts: Record<string, unknown> = { schema };
        if (entityRefs && entityRefs.length > 0) {
          const isolatedIds = new Set(entityRefs.map(r => r.expressId));
          exportOpts.visibleOnly = true;
          exportOpts.isolatedEntityIds = isolatedIds;
          exportOpts.hiddenEntityIds = new Set<number>();
        }
        return exportToStep(store, exportOpts as Partial<StepExportOptions>);
      },
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
    const store = this.store;
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
