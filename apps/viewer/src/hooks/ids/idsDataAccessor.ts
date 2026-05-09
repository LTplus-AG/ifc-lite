/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Data Accessor Factory
 *
 * Creates an IFCDataAccessor bridge from an IfcDataStore to the IDS
 * validator's expected interface. This is a pure function with no
 * React dependencies. Mirrors the buildingSMART/IDS implementer-corpus
 * harness in `scripts/test-ids-corpus.mjs` to keep production parity.
 */

import type {
  IFCDataAccessor,
  PropertyValueResult,
  PropertySetInfo,
  ClassificationInfo,
  MaterialInfo,
  ParentInfo,
  PartOfRelation,
} from '@ifc-lite/ids';
import {
  type IfcDataStore,
  EntityExtractor,
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypePropertiesOnDemand,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

// Map IDS PartOf relations to the numeric RelationshipType enum the
// graph keys on. Passing strings here was a long-standing silent bug:
// `getRelated` matched nothing → every partOf check looked like
// "no parent" → fail-when-required, pass-when-prohibited.
const PARTOF_REL_MAP: Record<PartOfRelation, RelationshipType | undefined> = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelAssignsToGroup: RelationshipType.AssignsToGroup,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

function flattenMaterials(matInfo: ReturnType<typeof extractMaterialsOnDemand>): MaterialInfo[] {
  if (!matInfo) return [];
  const out: MaterialInfo[] = [];
  const push = (name?: string, category?: string) => {
    if (!name) return;
    out.push({ name, category });
  };
  switch (matInfo.type) {
    case 'Material':
      push(matInfo.name, matInfo.category);
      // IDS material `<value>` may match either the Name OR the
      // Category — push category as an alias so value checks match.
      if (matInfo.category) push(matInfo.category, matInfo.category);
      break;
    case 'MaterialList':
      for (const m of matInfo.materials || []) {
        if (typeof m === 'string') {
          push(m);
        } else if (m && typeof m === 'object') {
          push(m.name, m.category);
          if (m.category) push(m.category, m.category);
        }
      }
      break;
    case 'MaterialLayerSet':
      push(matInfo.name);
      for (const layer of matInfo.layers || []) {
        push(layer.materialName, layer.category);
        push(layer.name, layer.category);
        if (layer.materialCategory) push(layer.materialCategory, layer.materialCategory);
      }
      break;
    case 'MaterialConstituentSet':
      push(matInfo.name);
      for (const c of matInfo.constituents || []) {
        push(c.materialName, c.category);
        push(c.name, c.category);
        if (c.materialCategory) push(c.materialCategory, c.materialCategory);
      }
      break;
    case 'MaterialProfileSet':
      push(matInfo.name);
      for (const p of matInfo.profiles || []) {
        push(p.materialName, p.category);
        push(p.name, p.category);
        if (p.materialCategory) push(p.materialCategory, p.materialCategory);
      }
      break;
  }
  return out;
}

function findAttributeValue(
  dataStore: IfcDataStore,
  expressId: number,
  attributeName: string
): string | number | boolean | undefined {
  const lower = attributeName.toLowerCase();
  const all = extractAllEntityAttributes(dataStore, expressId);
  for (const a of all) {
    if (a.name.toLowerCase() === lower) return a.value;
  }
  return undefined;
}

function idsDataTypeForProperty(type: number | string | undefined): string {
  if (typeof type === 'string') {
    if (type.startsWith('IFC') || type.startsWith('Ifc')) return type.toUpperCase();
    return 'IFCLABEL';
  }
  // PropertyValueType enum from @ifc-lite/data.
  switch (type) {
    case 0: return 'IFCLABEL';
    case 1: return 'IFCREAL';
    case 2: return 'IFCINTEGER';
    case 3: return 'IFCBOOLEAN';
    case 4: return 'IFCLOGICAL';
    case 5: return 'IFCLABEL';
    case 6: return 'IFCIDENTIFIER';
    case 7: return 'IFCTEXT';
    case 8: return 'IFCLABEL';
    case 9: return 'IFCIDENTIFIER';
    case 10: return 'IFCLABEL';
    default: return 'IFCLABEL';
  }
}

function idsDataTypeForQuantity(type: number): string {
  switch (type) {
    case 0: return 'IFCLENGTHMEASURE';
    case 1: return 'IFCAREAMEASURE';
    case 2: return 'IFCVOLUMEMEASURE';
    case 3: return 'IFCCOUNTMEASURE';
    case 4: return 'IFCMASSMEASURE';
    case 5: return 'IFCTIMEMEASURE';
    default: return 'IFCLABEL';
  }
}

/**
 * Per IDS spec, IDS literal values for IFC measure types are always in
 * base SI units. The IFC store keeps the raw author value, so when the
 * project's length unit is `MILLI`, a stored `1000` length means
 * `1.0 metre` and the IDS check `1` should match. Applies the
 * project's `lengthUnitScale` to numeric values for length measures.
 *
 * Properties without a declared dataType (notably IfcPropertyTableValue,
 * where columns mix labels and measures) get a conservative double-up:
 * every numeric candidate is surfaced both raw and scaled.
 */
function applyUnitConversion(
  rawValue: string | number | boolean | null,
  rawValues: string[] | undefined,
  dataType: string | undefined,
  scale: number | undefined
): { value: string | number | boolean | null; values: string[] | undefined } {
  if (!scale || scale === 1) {
    return { value: rawValue, values: rawValues };
  }
  const upper = dataType ? dataType.toUpperCase() : '';
  const isLength = upper === 'IFCLENGTHMEASURE' || upper === 'IFCPOSITIVELENGTHMEASURE';
  const isUntypedTable = !dataType && Array.isArray(rawValues) && rawValues.length > 0;
  if (!isLength && !isUntypedTable) {
    return { value: rawValue, values: rawValues };
  }
  const convertNum = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (Number.isFinite(n)) return n * scale;
    return null;
  };
  if (isLength) {
    const converted = (() => {
      const c = convertNum(rawValue);
      return c == null ? rawValue : c;
    })();
    const values = Array.isArray(rawValues)
      ? rawValues.map((v) => {
          const c = convertNum(v);
          return c == null ? String(v) : String(c);
        })
      : rawValues;
    return { value: converted, values };
  }
  // Untyped table — keep raw values and append scaled copies for
  // every numeric candidate so either unit space matches.
  const expanded: string[] = [];
  for (const v of rawValues!) {
    expanded.push(String(v));
    const c = convertNum(v);
    if (c != null && String(c) !== String(v)) expanded.push(String(c));
  }
  return { value: rawValue, values: expanded };
}

function collectAllPropertySets(
  dataStore: IfcDataStore,
  expressId: number
): PropertySetInfo[] {
  const out: PropertySetInfo[] = [];
  const scale = dataStore.lengthUnitScale;
  type RawProp = {
    name: string;
    value: unknown;
    type: unknown;
    values?: string[];
    dataType?: string;
  };
  let props: Array<{ name: string; properties: RawProp[] }> | undefined =
    dataStore.properties?.getForEntity?.(expressId) as
      | Array<{ name: string; properties: RawProp[] }>
      | undefined;
  if (!props || props.length === 0) {
    props = extractPropertiesOnDemand(dataStore, expressId) as Array<{
      name: string;
      properties: RawProp[];
    }>;
  }
  if (props && props.length > 0) {
    for (const pset of props) {
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => {
          const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
          // Prefer the IFC-declared measure name (IFCDATE, IFCBOOLEAN, …)
          // when the parser surfaces it. Multi-valued tables omit a
          // single dataType so the IDS dataType gate can no-op.
          const dataType = p.dataType ?? (hasMultiValue ? undefined : idsDataTypeForProperty(p.type as number | string | undefined));
          const baseValue = Array.isArray(p.value) ? JSON.stringify(p.value) : (p.value as string | number | boolean | null);
          const baseValues = hasMultiValue ? (p.values as string[]) : undefined;
          const converted = applyUnitConversion(baseValue, baseValues, dataType, scale);
          return {
            name: p.name,
            value: converted.value,
            dataType: dataType ?? '',
            ...(converted.values ? { values: converted.values } : {}),
          };
        }),
      });
    }
  }

  let quantities = dataStore.quantities?.getForEntity?.(expressId);
  if (!quantities || quantities.length === 0) {
    quantities = extractQuantitiesOnDemand(dataStore, expressId);
  }
  if (quantities && quantities.length > 0) {
    for (const qset of quantities) {
      out.push({
        name: qset.name,
        properties: (qset.quantities || []).map((q) => ({
          name: q.name,
          value: q.value,
          dataType: idsDataTypeForQuantity(q.type),
        })),
      });
    }
  }

  // Predefined property-set entities (`IfcDoorPanelProperties`, …) are
  // connected to elements via `IfcRelDefinesByProperties` like a normal
  // pset, but their properties live as schema-defined ATTRIBUTES on
  // the entity itself. Surface them as a pset whose name is the
  // entity's `Name` and whose properties are the schema-defined
  // attribute slots beyond Name/Description.
  const psetIds =
    dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByProperties, 'inverse') || [];
  for (const psetId of psetIds) {
    const ref = dataStore.entityIndex?.byId?.get?.(psetId);
    if (!ref) continue;
    const tu = String((ref as { type?: unknown }).type).toUpperCase();
    if (tu === 'IFCPROPERTYSET' || tu === 'IFCELEMENTQUANTITY') continue;
    if (!tu.endsWith('PROPERTIES')) continue;
    const allAttrs = extractAllEntityAttributes(dataStore, psetId);
    const psetName = allAttrs.find((a) => a.name === 'Name')?.value;
    if (typeof psetName !== 'string' || !psetName) continue;
    if (out.some((p) => p.name === psetName)) continue;
    const properties = allAttrs
      .filter(
        (a) =>
          a.name !== 'GlobalId' &&
          a.name !== 'Name' &&
          a.name !== 'Description' &&
          a.value !== undefined &&
          a.value !== ''
      )
      .map((a) => ({
        name: a.name,
        value: a.value,
        // Without a per-attribute schema lookup the dataType is left
        // empty; the IDS dataType gate then no-ops for these slots.
        dataType: '',
      }));
    if (properties.length > 0) out.push({ name: psetName, properties });
  }

  // Inherit property sets from the IfcRelDefinesByType target — per
  // IDS spec the instance and its type share property sets.
  const inherited = extractTypePropertiesOnDemand(dataStore, expressId);
  if (inherited && inherited.properties && inherited.properties.length > 0) {
    const seen = new Set(out.map((p) => p.name));
    for (const pset of inherited.properties) {
      if (seen.has(pset.name)) continue;
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => {
          const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
          const dataType = p.dataType ?? (hasMultiValue ? undefined : idsDataTypeForProperty(p.type as number | string | undefined));
          const baseValue = Array.isArray(p.value) ? JSON.stringify(p.value) : (p.value as string | number | boolean | null);
          const baseValues = hasMultiValue ? p.values : undefined;
          const converted = applyUnitConversion(baseValue, baseValues, dataType, scale);
          return {
            name: p.name,
            value: converted.value,
            dataType: dataType ?? '',
            ...(converted.values ? { values: converted.values } : {}),
          };
        }),
      });
    }
  }

  if (out.length === 0) {
    const typePsets = extractTypeEntityOwnProperties(dataStore, expressId);
    if (typePsets.length > 0) {
      for (const pset of typePsets) {
        out.push({
          name: pset.name,
          properties: (pset.properties || []).map((p) => ({
            name: p.name,
            value: Array.isArray(p.value) ? JSON.stringify(p.value) : (p.value as string | number | boolean | null),
            dataType: idsDataTypeForProperty(p.type as number | string | undefined),
            ...(Array.isArray(p.values) && p.values.length > 0 ? { values: p.values } : {}),
          })),
        });
      }
    }
  }
  return out;
}

/**
 * Create an IFCDataAccessor from an IfcDataStore
 * This bridges the viewer's data store to the IDS validator's interface
 */
export function createDataAccessor(
  dataStore: IfcDataStore,
  _modelId: string
): IFCDataAccessor {
  return {
    getEntityType(expressId: number): string | undefined {
      // The columnar entity table only summarises "interesting"
      // entities (spatial, building elements, etc.); resource-level
      // types like `IfcTask`, `IfcMaterial`, `IfcClassification`
      // resolve to `'Unknown'` there. Fall back to the raw type name
      // from `entityIndex.byId` so applicability checks for those
      // types still match.
      const entityType = dataStore.entities?.getTypeName?.(expressId);
      if (entityType && entityType !== 'Unknown') return entityType;

      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        const entry = byId.get(expressId);
        if (entry) {
          return typeof entry === 'object' && 'type' in entry ? String(entry.type) : undefined;
        }
      }
      return undefined;
    },

    getEntityName(expressId: number): string | undefined {
      // Distinguish "slot truly absent" (`undefined`) from "slot
      // explicitly empty" (`''`) — the IDS optional-attribute fixtures
      // hinge on it. The columnar `entities.getName` shim returns `''`
      // for either case, so we round-trip through the attribute
      // extractor first to preserve the explicit empty string.
      const fromAttr = findAttributeValue(dataStore, expressId, 'Name');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const n = dataStore.entities?.getName?.(expressId);
      return n || undefined;
    },

    getGlobalId(expressId: number): string | undefined {
      const fromAttr = findAttributeValue(dataStore, expressId, 'GlobalId');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const g = dataStore.entities?.getGlobalId?.(expressId);
      return g || undefined;
    },

    getDescription(expressId: number): string | undefined {
      const fromAttr = findAttributeValue(dataStore, expressId, 'Description');
      if (fromAttr !== undefined && typeof fromAttr === 'string') return fromAttr;
      const d = dataStore.entities?.getDescription?.(expressId);
      return d || undefined;
    },

    getAttributeNames(expressId: number): string[] {
      return extractAllEntityAttributes(dataStore, expressId).map((a) => a.name);
    },

    getPredefinedTypeRaw(expressId: number): string | undefined {
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = typeof pdt?.value === 'string' && pdt.value ? pdt.value : undefined;
      if (pdtValue && pdtValue !== 'NOTDEFINED') return pdtValue;
      // Inherit from the defining type (IfcRelDefinesByType).
      const typeIds =
        dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse') || [];
      for (const typeId of typeIds) {
        const typeAttrs = extractAllEntityAttributes(dataStore, typeId);
        const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
        const typeVal = typeof typePdt?.value === 'string' && typePdt.value ? typePdt.value : undefined;
        if (typeVal && typeVal !== 'NOTDEFINED') return typeVal;
      }
      return pdtValue;
    },

    getObjectType(expressId: number): string | undefined {
      // IDS predefined-type semantics:
      //  - If PredefinedType is `USERDEFINED`, the real type lives in
      //    ElementType / ObjectType / ProcessType / ResourceType.
      //  - If PredefinedType is `NOTDEFINED` or absent, fall back to
      //    ObjectType (instance) or the type's slot.
      //  - Otherwise the PredefinedType enum value IS the answer.
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = pdt?.value;
      if (typeof pdtValue === 'string' && pdtValue && pdtValue !== 'NOTDEFINED' && pdtValue !== 'USERDEFINED') {
        return pdtValue;
      }
      const userSlot =
        allAttrs.find((a) => a.name === 'ElementType') ||
        allAttrs.find((a) => a.name === 'ObjectType') ||
        allAttrs.find((a) => a.name === 'ProcessType') ||
        allAttrs.find((a) => a.name === 'ResourceType');
      if (userSlot && typeof userSlot.value === 'string' && userSlot.value) return userSlot.value;
      // Inherit from defining type when the instance has neither.
      const typeIds =
        dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse') || [];
      for (const typeId of typeIds) {
        const typeAttrs = extractAllEntityAttributes(dataStore, typeId);
        const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
        const typePdtValue = typePdt?.value;
        if (
          typeof typePdtValue === 'string' &&
          typePdtValue &&
          typePdtValue !== 'NOTDEFINED' &&
          typePdtValue !== 'USERDEFINED'
        ) {
          return typePdtValue;
        }
        const typeUserSlot =
          typeAttrs.find((a) => a.name === 'ElementType') ||
          typeAttrs.find((a) => a.name === 'ObjectType') ||
          typeAttrs.find((a) => a.name === 'ProcessType') ||
          typeAttrs.find((a) => a.name === 'ResourceType');
        if (typeUserSlot && typeof typeUserSlot.value === 'string' && typeUserSlot.value) {
          return typeUserSlot.value;
        }
      }
      const ot = dataStore.entities?.getObjectType?.(expressId);
      if (ot) return ot;
      return typeof pdtValue === 'string' && pdtValue ? pdtValue : undefined;
    },

    getEntitiesByType(typeName: string): number[] {
      const byType = dataStore.entityIndex?.byType;
      if (byType) {
        const ids = byType.get(typeName.toUpperCase());
        if (ids) return Array.from(ids);
      }
      return [];
    },

    getAllEntityIds(): number[] {
      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        return Array.from(byId.keys());
      }
      return [];
    },

    getPropertyValue(
      expressId: number,
      propertySetName: string,
      propertyName: string
    ): PropertyValueResult | undefined {
      const all = collectAllPropertySets(dataStore, expressId);
      for (const pset of all) {
        if (pset.name.toLowerCase() !== propertySetName.toLowerCase()) continue;
        for (const prop of pset.properties || []) {
          if (prop.name.toLowerCase() !== propertyName.toLowerCase()) continue;
          return {
            value: prop.value,
            dataType: prop.dataType,
            propertySetName: pset.name,
            propertyName: prop.name,
          };
        }
      }
      return undefined;
    },

    getPropertySets(expressId: number): PropertySetInfo[] {
      return collectAllPropertySets(dataStore, expressId);
    },

    getClassifications(expressId: number): ClassificationInfo[] {
      type ClassRecord = {
        system?: string;
        identification?: string;
        name?: string;
        path?: string[];
      };
      const list: ClassRecord[] = [...(extractClassificationsOnDemand(dataStore, expressId) || [])];

      // Non-rooted resources (IfcMaterial, IfcProfileDef, …) carry
      // classifications via `IfcExternalReferenceRelationship` rather
      // than `IfcRelAssociatesClassification`. Scan that table for
      // any pointing at the current entity and resolve the chain.
      const erRefs = dataStore.entityIndex?.byType?.get?.('IFCEXTERNALREFERENCERELATIONSHIP') || [];
      if (erRefs.length > 0 && dataStore.source?.length) {
        const ex = new EntityExtractor(dataStore.source);
        for (const erId of erRefs) {
          const erRef = dataStore.entityIndex.byId.get(erId);
          if (!erRef) continue;
          const erEntity = ex.extractEntity(erRef);
          if (!erEntity) continue;
          // [Name, Description, RelatingReference, RelatedResourceObjects]
          const relating = erEntity.attributes?.[2];
          const related = erEntity.attributes?.[3];
          if (typeof relating !== 'number') continue;
          if (!Array.isArray(related)) continue;
          if (!related.includes(expressId)) continue;
          const refRef = dataStore.entityIndex.byId.get(relating);
          if (!refRef) continue;
          const refEntity = ex.extractEntity(refRef);
          if (!refEntity) continue;
          const tu = refEntity.type.toUpperCase();
          if (tu !== 'IFCCLASSIFICATIONREFERENCE') continue;
          const a = refEntity.attributes || [];
          const info: ClassRecord = {
            identification: typeof a[1] === 'string' ? a[1] : undefined,
            name: typeof a[2] === 'string' ? a[2] : undefined,
            path: [],
          };
          let cursor = typeof a[3] === 'number' ? a[3] : undefined;
          const seen = new Set<number>();
          while (cursor !== undefined && !seen.has(cursor)) {
            seen.add(cursor);
            const cur = dataStore.entityIndex.byId.get(cursor);
            if (!cur) break;
            const e = ex.extractEntity(cur);
            if (!e) break;
            const cu = e.type.toUpperCase();
            const ca = e.attributes || [];
            if (cu === 'IFCCLASSIFICATION') {
              info.system = typeof ca[3] === 'string' ? ca[3] : undefined;
              break;
            }
            if (cu === 'IFCCLASSIFICATIONREFERENCE') {
              const code = typeof ca[1] === 'string' ? ca[1] : (typeof ca[2] === 'string' ? ca[2] : undefined);
              if (code) info.path!.unshift(code);
              cursor = typeof ca[3] === 'number' ? ca[3] : undefined;
              continue;
            }
            break;
          }
          list.push(info);
        }
      }

      const out: ClassificationInfo[] = [];
      for (const c of list) {
        const system = c.system || '';
        const baseValue = c.identification || c.name || '';
        // Always push at least one entry per associated classification —
        // even when the value is empty — so optional-cardinality value
        // mismatches register as a value mismatch rather than as a
        // missing-classification (which optional pardons).
        out.push({ system, value: baseValue, name: c.name });
        // Each parent reference in the chain is also a valid match
        // candidate per IDS spec (`EF_25_10_25` matches a requirement
        // of `EF_25_10`).
        if (Array.isArray(c.path)) {
          for (const code of c.path) {
            if (code && code !== baseValue) {
              out.push({ system, value: code, name: c.name });
            }
          }
        }
      }
      return out;
    },

    getMaterials(expressId: number): MaterialInfo[] {
      return flattenMaterials(extractMaterialsOnDemand(dataStore, expressId));
    },

    getParent(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo | undefined {
      const all = this.getAncestors!(expressId, relationType);
      return all.length > 0 ? all[0] : undefined;
    },

    getAncestors(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo[] {
      const relationships = dataStore.relationships;
      if (!relationships?.getRelated) return [];
      const relType = PARTOF_REL_MAP[relationType];
      if (relType === undefined) return [];
      // BFS up the graph — IDS partOf is transitive, so any reachable
      // ancestor counts.
      const out: ParentInfo[] = [];
      const seen = new Set<number>([expressId]);
      const queue = [expressId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        const parents = relationships.getRelated(id, relType, 'inverse');
        for (const parentId of parents || []) {
          if (seen.has(parentId)) continue;
          seen.add(parentId);
          out.push({
            expressId: parentId,
            entityType: this.getEntityType(parentId) || 'Unknown',
            predefinedType: this.getObjectType(parentId),
          });
          queue.push(parentId);
        }
      }
      return out;
    },

    getAttribute(expressId: number, attributeName: string): string | number | boolean | undefined {
      const lowerName = attributeName.toLowerCase();
      switch (lowerName) {
        case 'name':
          return this.getEntityName(expressId);
        case 'description':
          return this.getDescription(expressId);
        case 'globalid':
          return this.getGlobalId(expressId);
        case 'objecttype':
        case 'predefinedtype':
          return this.getObjectType(expressId);
        default: {
          // For arbitrary attributes (EditionDate, Tag, etc.), fall back
          // to the parser's full-attribute extractor.
          const fromExtract = findAttributeValue(dataStore, expressId, attributeName);
          if (fromExtract !== undefined) return fromExtract;
          const entities = dataStore.entities as {
            getAttribute?: (id: number, attr: string) => string | undefined;
          };
          return entities?.getAttribute
            ? entities.getAttribute(expressId, attributeName)
            : undefined;
        }
      }
    },
  };
}
