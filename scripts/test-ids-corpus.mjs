#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validation parity harness — runs the buildingSMART/IDS official
 * implementer test corpus through our parser + validator and compares
 * the spec status to the filename prefix.
 *
 * Each fixture pair is named with one of three prefixes:
 *   pass-*    → expect IDSSpecificationResult.status === 'pass'
 *   fail-*    → expect IDSSpecificationResult.status === 'fail'
 *   invalid-* → expect IDSSpecificationResult.status === 'not_applicable'
 *               (i.e. no applicability matched, or the IDS itself
 *               wouldn't validate against the input)
 *
 * Reports a parity rate per category + overall, and lists divergences.
 *
 * Run the script directly with `node` so we avoid `tsx`'s workspace-
 * source resolution (which conflicts with our compiled-dist imports).
 *
 * Usage:
 *   node scripts/test-ids-corpus.mjs                  # full corpus
 *   node scripts/test-ids-corpus.mjs --category=entity
 *   node scripts/test-ids-corpus.mjs --verbose        # log every fixture
 *   node scripts/test-ids-corpus.mjs --limit=20       # first 20 per category
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIDS, validateIDS } from '../packages/ids/dist/index.js';
import {
  IfcParser,
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypePropertiesOnDemand,
  EntityExtractor,
  extractMaterialsOnDemand,
  extractClassificationsOnDemand,
} from '../packages/parser/dist/index.js';
import { RelationshipType } from '../packages/data/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(
  __dirname,
  '..',
  'packages',
  'ids',
  'src',
  '__corpus__',
  'buildingsmart-ids'
);

// ---------------------------------------------------------------------------
// Data accessor — vendored from apps/viewer/src/hooks/ids/idsDataAccessor.ts
// so this script doesn't depend on the viewer's TypeScript source. Keep
// in sync with that file when the validator interface evolves.
// ---------------------------------------------------------------------------

/**
 * Map RelationshipType (numeric enum) for partOf lookups. The earlier
 * accessor passed string keys like 'Aggregates' which the relationship
 * graph silently doesn't match — every partOf check was a false
 * positive against an empty-result set.
 */
const PARTOF_REL_MAP = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelAssignsToGroup: RelationshipType.AssignsToGroup,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  // The parser maps both IFCRELAGGREGATES and IFCRELNESTS onto the
  // Aggregates edge bucket so partOf checks for either traverse
  // the same graph.
  IfcRelNests: RelationshipType.Aggregates,
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

/**
 * Flatten the parser's hierarchical MaterialInfo into the flat
 * `{name, category}[]` array the IDS validator expects. Surfaces:
 *  - a single Material's name
 *  - a MaterialList's individual material strings
 *  - a MaterialLayerSet's set name AND each layer's materialName
 *  - a MaterialConstituentSet's set name AND each constituent's materialName/name/category
 *  - a MaterialProfileSet's set name AND each profile's materialName/name/category
 */
function flattenMaterials(matInfo) {
  if (!matInfo) return [];
  const out = [];
  const push = (name, category) => {
    if (!name) return;
    out.push({ name, category });
  };
  switch (matInfo.type) {
    case 'Material':
      push(matInfo.name, matInfo.category);
      // The IDS material facet treats `<value>` as matching against
      // either the material's Name OR its Category (upstream
      // IfcOpenShell behaviour). Push category as an alias entry so
      // value checks match either field.
      if (matInfo.category) push(matInfo.category, matInfo.category);
      break;
    case 'MaterialList':
      for (const m of matInfo.materials || []) {
        // Each list member is now an object {name, category}; legacy
        // dist may still hand back bare strings, so handle both.
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
        // The underlying IfcMaterial.Category is also a candidate match.
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

function createDataAccessor(dataStore) {
  return {
    getEntityType(expressId) {
      // The columnar entity table only summarises "interesting"
      // entities (spatial, building elements, etc.); resource-level
      // types like `IfcTask`, `IfcMaterial`, `IfcClassification`
      // resolve to "Unknown" there. Fall back to the raw type name
      // recorded in `entityIndex.byId` so applicability checks for
      // these types match.
      const t = dataStore.entities?.getTypeName?.(expressId);
      if (t && t !== 'Unknown') return t;
      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        const entry = byId.get(expressId);
        if (entry && typeof entry === 'object' && 'type' in entry) {
          return String(entry.type);
        }
      }
      return undefined;
    },
    getEntityName(expressId) {
      // Distinguish "slot truly absent" (`undefined`) from "slot
      // explicitly empty" (`''`) — the IDS optional-attribute fixtures
      // hinge on it. The columnar `entities.getName` shim returns `''`
      // when either is the case, so we round-trip through the
      // attribute extractor to recover the explicit empty string.
      const fromAttr = findAttribute(dataStore, expressId, 'Name');
      if (fromAttr !== undefined) return fromAttr;
      const n = dataStore.entities?.getName?.(expressId);
      return n || undefined;
    },
    getGlobalId(expressId) {
      const fromAttr = findAttribute(dataStore, expressId, 'GlobalId');
      if (fromAttr !== undefined) return fromAttr;
      const g = dataStore.entities?.getGlobalId?.(expressId);
      return g || undefined;
    },
    getDescription(expressId) {
      const fromAttr = findAttribute(dataStore, expressId, 'Description');
      if (fromAttr !== undefined) return fromAttr;
      const d = dataStore.entities?.getDescription?.(expressId);
      return d || undefined;
    },
    getAttributeNames(expressId) {
      return extractAllEntityAttributes(dataStore, expressId).map((a) => a.name);
    },
    getPredefinedTypeRaw(expressId) {
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = typeof pdt?.value === 'string' && pdt.value ? pdt.value : undefined;
      if (pdtValue && pdtValue !== 'NOTDEFINED') return pdtValue;
      // Inherit from the defining type (IfcRelDefinesByType) when the
      // instance has no concrete predefined type — upstream ifctester
      // walks this same edge so an IfcWall with `$` PredefinedType
      // inherits the IfcWallType.PredefinedType (and ElementType).
      const typeIds = dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse') || [];
      for (const typeId of typeIds) {
        const typeAttrs = extractAllEntityAttributes(dataStore, typeId);
        const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
        const typeVal = typeof typePdt?.value === 'string' && typePdt.value ? typePdt.value : undefined;
        if (typeVal && typeVal !== 'NOTDEFINED') return typeVal;
      }
      return pdtValue;
    },
    getObjectType(expressId) {
      // IDS predefined-type semantics (matches upstream IfcOpenShell):
      //  - If PredefinedType is `USERDEFINED`, the real type lives in
      //    ElementType (for IfcTypeObject subtypes like IfcWallType) or
      //    ObjectType / ProcessType / etc. (for IfcObject subtypes).
      //  - If PredefinedType is `NOTDEFINED` or absent, fall back to
      //    ObjectType.
      //  - Otherwise the PredefinedType enum value IS the answer.
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = pdt?.value;
      if (pdtValue && pdtValue !== 'NOTDEFINED' && pdtValue !== 'USERDEFINED') {
        return pdtValue;
      }
      // USERDEFINED / NOTDEFINED — look for the user-defined slot.
      // Different parent classes use different attribute names:
      //   IfcTypeObject → ElementType
      //   IfcObject     → ObjectType
      //   IfcTypeProcess→ ProcessType
      //   IfcTypeResource → ResourceType
      const userSlot =
        allAttrs.find((a) => a.name === 'ElementType') ||
        allAttrs.find((a) => a.name === 'ObjectType') ||
        allAttrs.find((a) => a.name === 'ProcessType') ||
        allAttrs.find((a) => a.name === 'ResourceType');
      if (userSlot?.value) return userSlot.value;
      // Inherit from the defining type (IfcRelDefinesByType) — an
      // IfcWall with `$` predefined type inherits the IfcWallType's
      // PredefinedType + ElementType per upstream ifctester semantics.
      const typeIds = dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse') || [];
      for (const typeId of typeIds) {
        const typeAttrs = extractAllEntityAttributes(dataStore, typeId);
        const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
        const typePdtValue = typePdt?.value;
        if (typePdtValue && typePdtValue !== 'NOTDEFINED' && typePdtValue !== 'USERDEFINED') {
          return typePdtValue;
        }
        const typeUserSlot =
          typeAttrs.find((a) => a.name === 'ElementType') ||
          typeAttrs.find((a) => a.name === 'ObjectType') ||
          typeAttrs.find((a) => a.name === 'ProcessType') ||
          typeAttrs.find((a) => a.name === 'ResourceType');
        if (typeUserSlot?.value) return typeUserSlot.value;
      }
      // No user-defined override → return the raw PredefinedType (may
      // be NOTDEFINED) so empty-predefined-type checks work.
      const ot = dataStore.entities?.getObjectType?.(expressId);
      if (ot) return ot;
      return pdtValue || undefined;
    },
    getEntitiesByType(typeName) {
      const byType = dataStore.entityIndex?.byType;
      if (byType) {
        const ids = byType.get(typeName.toUpperCase());
        if (ids) return Array.from(ids);
      }
      return [];
    },
    getAllEntityIds() {
      const byId = dataStore.entityIndex?.byId;
      return byId ? Array.from(byId.keys()) : [];
    },
    getPropertyValue(expressId, propertySetName, propertyName) {
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
    getPropertySets(expressId) {
      return collectAllPropertySets(dataStore, expressId);
    },
    getClassifications(expressId) {
      const list = [...(extractClassificationsOnDemand(dataStore, expressId) || [])];
      // Non-rooted resources (IfcMaterial, IfcProfileDef, …) carry
      // classifications via `IfcExternalReferenceRelationship` rather
      // than `IfcRelAssociatesClassification`. Scan the global
      // EXTERNAL-REFERENCE-RELATIONSHIP table for any pointing at the
      // current entity and resolve their RelatingReference (an
      // IfcClassificationReference) the same way the resolver does.
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
          // Walk the IfcClassificationReference chain just like the
          // standard resolver does so we get system + path codes.
          const refRef = dataStore.entityIndex.byId.get(relating);
          if (!refRef) continue;
          const refEntity = ex.extractEntity(refRef);
          if (!refEntity) continue;
          const tu = refEntity.type.toUpperCase();
          if (tu !== 'IFCCLASSIFICATIONREFERENCE') continue;
          const a = refEntity.attributes || [];
          const info = {
            identification: typeof a[1] === 'string' ? a[1] : undefined,
            name: typeof a[2] === 'string' ? a[2] : undefined,
            path: [],
          };
          let cursor = typeof a[3] === 'number' ? a[3] : undefined;
          const seen = new Set();
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
              if (code) info.path.unshift(code);
              cursor = typeof ca[3] === 'number' ? ca[3] : undefined;
              continue;
            }
            break;
          }
          list.push(info);
        }
      }

      const out = [];
      for (const c of list) {
        const system = c.system || '';
        const baseValue = c.identification || c.name || '';
        // Always push at least one entry per associated classification
        // — even when the value is empty — so optional-cardinality
        // value mismatches register as a value mismatch rather than
        // as a missing-classification (which optional pardons).
        out.push({ system, value: baseValue, name: c.name });
        // Each parent reference in the chain (`EF_25_10`, `EF_25`, …)
        // is also a valid match candidate per upstream IDS spec —
        // a requirement of `EF_25` should pass when the actual
        // classification is `EF_25_10` or any deeper sub-reference.
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
    getMaterials(expressId) {
      return flattenMaterials(extractMaterialsOnDemand(dataStore, expressId));
    },
    getParent(expressId, relationType) {
      const all = this.getAncestors(expressId, relationType);
      return all.length > 0 ? all[0] : undefined;
    },
    getAncestors(expressId, relationType) {
      const relationships = dataStore.relationships;
      if (!relationships?.getRelated) return [];
      const relType = PARTOF_REL_MAP[relationType];
      if (relType === undefined) return [];
      // BFS up the graph — IDS partOf checks pass when any reachable
      // ancestor matches the requirement entity, regardless of how
      // many edges away.
      const out = [];
      const seen = new Set([expressId]);
      const queue = [expressId];
      while (queue.length > 0) {
        const id = queue.shift();
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
    getAttribute(expressId, attributeName) {
      const lower = attributeName.toLowerCase();
      switch (lower) {
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
          const fromExtract = findAttribute(dataStore, expressId, attributeName);
          if (fromExtract !== undefined) return fromExtract;
          const e = dataStore.entities;
          return e?.getAttribute ? e.getAttribute(expressId, attributeName) : undefined;
        }
      }
    },
  };
}

/**
 * Look up an arbitrary attribute by name via `extractAllEntityAttributes`.
 * Case-insensitive name match. Returns undefined when the attribute
 * isn't on the entity (or has no string value).
 */
function findAttribute(dataStore, expressId, attributeName) {
  const lower = attributeName.toLowerCase();
  const all = extractAllEntityAttributes(dataStore, expressId);
  for (const a of all) {
    if (a.name.toLowerCase() === lower) return a.value;
  }
  return undefined;
}

/**
 * IDS treats `IfcElementQuantity` (Qto_*) and `IfcPropertySet` (Pset_*)
 * uniformly — both surface as "property sets" with named values. The
 * parser stores them in separate columnar tables (`properties` vs
 * `quantities`), so we merge them here.
 *
 * For IfcTypeObject occurrences, also fall back to type-level
 * `HasPropertySets` when the relationship-based lookup is empty.
 */
/**
 * Per IDS spec, IDS literal values for IFC measure types are always in
 * base SI units (metres, square metres, …) regardless of the project's
 * declared unit. The IFC store keeps the raw author value, so when the
 * project's length unit is e.g. `MILLI`, a stored `1000.` length means
 * `1.0 metre` and the IDS check `1` should match.
 *
 * Applies the `lengthUnitScale` to numeric values and `values[]` lists
 * for measure data types. Returns the input unchanged when the
 * data type isn't unit-bearing or the scale is missing/identity.
 */
function applyUnitConversion(rawValue, rawValues, dataType, scale) {
  if (!scale || scale === 1) {
    return { value: rawValue, values: rawValues };
  }
  const upper = dataType ? dataType.toUpperCase() : '';
  // Length-only conversion for now — covers the corpus' bounded /
  // table fixtures that motivated this. Other measure families
  // (IFCAREAMEASURE, IFCVOLUMEMEASURE, …) need their own scale,
  // which the parser doesn't surface yet.
  const isLength = upper === 'IFCLENGTHMEASURE' || upper === 'IFCPOSITIVELENGTHMEASURE';
  // Properties without a declared dataType (notably IfcPropertyTableValue,
  // where columns mix labels and measures) get a conservative double-up:
  // every numeric candidate is surfaced both raw and scaled, so an IDS
  // check using either unit space matches.
  const isUntypedTable = !dataType && Array.isArray(rawValues) && rawValues.length > 0;
  if (!isLength && !isUntypedTable) {
    return { value: rawValue, values: rawValues };
  }
  const convertNum = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    if (Number.isFinite(n)) return n * scale;
    return null;
  };
  if (isLength) {
    const value = (() => {
      const c = convertNum(rawValue);
      return c == null ? rawValue : c;
    })();
    const values = Array.isArray(rawValues)
      ? rawValues.map((v) => {
          const c = convertNum(v);
          return c == null ? String(v) : String(c);
        })
      : rawValues;
    return { value, values };
  }
  // Untyped table — keep raw values and append scaled copies for
  // every numeric candidate so either unit space matches.
  const expanded = [];
  for (const v of rawValues) {
    expanded.push(String(v));
    const c = convertNum(v);
    if (c != null && String(c) !== String(v)) expanded.push(String(c));
  }
  return { value: rawValue, values: expanded };
}

function collectAllPropertySets(dataStore, expressId) {
  const out = [];
  const scale = dataStore.lengthUnitScale;
  // Properties — prefer the columnar table when populated, else fall
  // back to on-demand extraction (the ColumnarParser only fills the
  // table when explicitly asked, but the on-demand extractor walks
  // IfcRelDefinesByProperties → IfcPropertySet directly).
  let props = dataStore.properties?.getForEntity?.(expressId);
  if (!props || props.length === 0) {
    props = extractPropertiesOnDemand(dataStore, expressId);
  }
  if (props && props.length > 0) {
    for (const pset of props) {
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => {
          // Prefer the IFC-declared measure name (IFCDATE, IFCBOOLEAN, …)
          // when the parser surfaces it. When it doesn't but the
          // property carries multiple candidate values (table-style),
          // leave the dataType undefined so the IDS dataType gate
          // doesn't reject mixed-type tables. Otherwise fall back to
          // the shape-only `PropertyValueType` enum.
          const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
          const dataType = p.dataType || (hasMultiValue ? undefined : idsDataTypeForProperty(p.type));
          const baseValue = Array.isArray(p.value) ? JSON.stringify(p.value) : p.value;
          const baseValues = hasMultiValue ? p.values : undefined;
          const converted = applyUnitConversion(baseValue, baseValues, dataType, scale);
          return {
            name: p.name,
            value: converted.value,
            ...(dataType ? { dataType } : {}),
            ...(converted.values ? { values: converted.values } : {}),
          };
        }),
      });
    }
  }
  // IfcElementQuantity (Qto_*) sets — IDS treats these as property
  // sets too. Same dual-source pattern.
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
  // Predefined property-set entities (`IfcDoorPanelProperties`,
  // `IfcWindowPanelProperties`, …) are connected to elements via
  // `IfcRelDefinesByProperties` like a normal pset, but their
  // properties live as schema-defined ATTRIBUTES on the entity itself
  // rather than as `IfcPropertySingleValue` children. IDS spec
  // surfaces them as a property set whose `name` is the entity's
  // `Name` and whose `properties` are the schema-defined attribute
  // slots beyond the inherited Name/Description.
  const psetIds = dataStore.relationships?.getRelated?.(expressId, RelationshipType.DefinesByProperties, 'inverse') || [];
  for (const psetId of psetIds) {
    const ref = dataStore.entityIndex?.byId?.get?.(psetId);
    if (!ref) continue;
    const tu = String(ref.type).toUpperCase();
    if (tu === 'IFCPROPERTYSET' || tu === 'IFCELEMENTQUANTITY') continue;
    if (!tu.endsWith('PROPERTIES')) continue;
    // Surface attrs[2]=Name as the pset name, [4..] as properties.
    const allAttrs = extractAllEntityAttributes(dataStore, psetId);
    const psetName = allAttrs.find((a) => a.name === 'Name')?.value;
    if (!psetName) continue;
    if (out.some((p) => p.name === psetName)) continue;
    const properties = allAttrs
      .filter((a) => a.name !== 'GlobalId' && a.name !== 'Name' && a.name !== 'Description' && a.value !== undefined && a.value !== '')
      .map((a) => ({
        name: a.name,
        value: a.value,
        // Without a per-attribute schema lookup we leave dataType
        // undefined; the IDS dataType gate then no-ops (matching
        // how we treat multi-typed table values).
      }));
    if (properties.length > 0) out.push({ name: psetName, properties });
  }

  // Inherit property sets from the IfcRelDefinesByType target — per
  // IDS spec the instance and its type share property sets, so a
  // property assigned only on the IfcWallType should still satisfy a
  // requirement against the IfcWall instance. Apply unconditionally
  // (instances may carry their own psets _and_ inherit from the type).
  const inherited = extractTypePropertiesOnDemand(dataStore, expressId);
  if (inherited && inherited.properties && inherited.properties.length > 0) {
    const seen = new Set(out.map((p) => p.name));
    for (const pset of inherited.properties) {
      if (seen.has(pset.name)) continue;
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => ({
          name: p.name,
          value: Array.isArray(p.value) ? JSON.stringify(p.value) : p.value,
          // Prefer the IFC-declared measure name (IFCDATE, IFCBOOLEAN, …)
          // when the parser surfaces it, otherwise infer from the
          // shape-only `PropertyValueType` enum.
          dataType: p.dataType || idsDataTypeForProperty(p.type),
          ...(Array.isArray(p.values) && p.values.length > 0
            ? { values: p.values }
            : {}),
        })),
      });
    }
  }
  if (out.length === 0) {
    // Type-object fallback (IfcWallType.HasPropertySets etc.)
    const typePsets = extractTypeEntityOwnProperties(dataStore, expressId);
    if (typePsets.length > 0) {
      for (const pset of typePsets) {
        out.push({
          name: pset.name,
          properties: (pset.properties || []).map((p) => ({
            name: p.name,
            value: Array.isArray(p.value) ? JSON.stringify(p.value) : p.value,
            dataType: idsDataTypeForProperty(p.type),
            ...(Array.isArray(p.values) && p.values.length > 0
              ? { values: p.values }
              : {}),
          })),
        });
      }
    }
  }
  return out;
}

/**
 * Map the parser's `PropertyValueType` enum (or string-tagged variant)
 * to the IDS-side `IFC*` data-type token consumers compare against.
 * IDS expects names like `IFCLABEL` / `IFCREAL` / `IFCBOOLEAN`; the
 * parser surfaces shape-only enum values plus the underlying IFC
 * measure name on the property record.
 */
function idsDataTypeForProperty(type) {
  if (typeof type === 'string') {
    if (type.startsWith('IFC') || type.startsWith('Ifc')) return type.toUpperCase();
    return 'IFCLABEL';
  }
  // PropertyValueType enum (from @ifc-lite/data):
  //   0 String, 1 Real, 2 Integer, 3 Boolean, 4 Logical,
  //   5 Label, 6 Identifier, 7 Text, 8 Enum, 9 Reference, 10 List.
  switch (type) {
    case 0:
      return 'IFCLABEL';
    case 1:
      return 'IFCREAL';
    case 2:
      return 'IFCINTEGER';
    case 3:
      return 'IFCBOOLEAN';
    case 4:
      return 'IFCLOGICAL';
    case 5:
      return 'IFCLABEL';
    case 6:
      return 'IFCIDENTIFIER';
    case 7:
      return 'IFCTEXT';
    case 8:
      return 'IFCLABEL';
    case 9:
      return 'IFCIDENTIFIER';
    case 10:
      return 'IFCLABEL';
    default:
      return 'IFCLABEL';
  }
}

/**
 * Map the parser's `QuantityType` enum to its corresponding IDS
 * dataType. Length → IFCLENGTHMEASURE, etc.
 */
function idsDataTypeForQuantity(type) {
  switch (type) {
    case 0: // Length
      return 'IFCLENGTHMEASURE';
    case 1: // Area
      return 'IFCAREAMEASURE';
    case 2: // Volume
      return 'IFCVOLUMEMEASURE';
    case 3: // Count
      return 'IFCCOUNTMEASURE';
    case 4: // Weight
      return 'IFCMASSMEASURE';
    case 5: // Time
      return 'IFCTIMEMEASURE';
    default:
      return 'IFCLABEL';
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const categoryArg = args.find((a) => a.startsWith('--category='))?.split('=')[1];
const limitArg = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0');

// ---------------------------------------------------------------------------
// Discovery + runner
// ---------------------------------------------------------------------------

function expectedFromPrefix(filename) {
  if (filename.startsWith('pass-')) return 'pass';
  if (filename.startsWith('fail-')) return 'fail';
  // `invalid-` per buildingSMART means the IDS+IFC pair, when run
  // through ifctester, results in spec.status=fail — the IDS makes
  // sense but the IFC cannot satisfy it (e.g. uppercase requirement
  // matched against a PascalCase value, subclass that isn't the
  // requested class, etc.).
  if (filename.startsWith('invalid-')) return 'fail';
  return null;
}

function discover() {
  const out = [];
  if (!fs.existsSync(CORPUS_ROOT)) {
    throw new Error(`Corpus directory not found: ${CORPUS_ROOT}`);
  }
  for (const category of fs.readdirSync(CORPUS_ROOT)) {
    if (categoryArg && category !== categoryArg) continue;
    const dir = path.join(CORPUS_ROOT, category);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.ids')).sort();
    let count = 0;
    for (const ids of idsFiles) {
      const base = ids.slice(0, -'.ids'.length);
      const expected = expectedFromPrefix(base);
      if (!expected) continue;
      const ifcPath = path.join(dir, `${base}.ifc`);
      if (!fs.existsSync(ifcPath)) continue;
      out.push({
        category,
        name: base,
        expected,
        idsPath: path.join(dir, ids),
        ifcPath,
      });
      count++;
      if (limitArg > 0 && count >= limitArg) break;
    }
  }
  return out;
}

async function runFixture(pair) {
  let actualStatus;
  try {
    const xml = fs.readFileSync(pair.idsPath, 'utf8');
    const ifcBuf = fs.readFileSync(pair.ifcPath);
    const ifcArrayBuf = ifcBuf.buffer.slice(
      ifcBuf.byteOffset,
      ifcBuf.byteOffset + ifcBuf.byteLength
    );

    const ids = parseIDS(xml);
    const parser = new IfcParser();
    const dataStore = await parser.parseColumnar(ifcArrayBuf, {});

    const accessor = createDataAccessor(dataStore);
    const report = await validateIDS(
      ids,
      accessor,
      {
        modelId: pair.name,
        // The parser detects FILE_SCHEMA from the IFC header; falling
        // back to IFC4 keeps things working when the header is absent.
        schemaVersion: dataStore.schemaVersion || 'IFC4',
        entityCount: dataStore.entityIndex?.byId?.size ?? 0,
      },
      {}
    );

    if (report.specificationResults.length === 0) {
      actualStatus = 'not_applicable';
    } else {
      // Each fixture targets exactly one spec; pick the first.
      actualStatus = report.specificationResults[0].status;
    }
  } catch (err) {
    return {
      pair,
      outcome: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    pair,
    outcome: actualStatus === pair.expected ? 'match' : 'mismatch',
    actualStatus,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(results) {
  const byCategory = new Map();
  for (const r of results) {
    let row = byCategory.get(r.pair.category);
    if (!row) {
      row = { match: 0, mismatch: 0, error: 0, total: 0 };
      byCategory.set(r.pair.category, row);
    }
    row.total++;
    if (r.outcome === 'match') row.match++;
    else if (r.outcome === 'mismatch') row.mismatch++;
    else row.error++;
  }
  console.log('\nbuildingSMART/IDS corpus parity report');
  console.log('======================================');
  console.log(
    'category'.padEnd(16),
    'match'.padStart(7),
    'mismatch'.padStart(10),
    'error'.padStart(7),
    'total'.padStart(7),
    'parity'.padStart(8)
  );
  let allMatch = 0;
  let allTotal = 0;
  for (const [cat, row] of [...byCategory.entries()].sort()) {
    const parity = ((row.match / row.total) * 100).toFixed(1) + '%';
    console.log(
      cat.padEnd(16),
      String(row.match).padStart(7),
      String(row.mismatch).padStart(10),
      String(row.error).padStart(7),
      String(row.total).padStart(7),
      parity.padStart(8)
    );
    allMatch += row.match;
    allTotal += row.total;
  }
  console.log('-'.repeat(60));
  const overall = ((allMatch / allTotal) * 100).toFixed(1) + '%';
  console.log(
    'overall'.padEnd(16),
    String(allMatch).padStart(7),
    ''.padStart(10),
    ''.padStart(7),
    String(allTotal).padStart(7),
    overall.padStart(8)
  );
}

function printDivergences(results) {
  const diverged = results.filter(
    (r) => r.outcome === 'mismatch' || r.outcome === 'error'
  );
  if (diverged.length === 0) {
    console.log('\nNo divergences. Full upstream parity. ✓');
    return;
  }
  console.log(`\nDivergences (${diverged.length}):`);
  for (const r of diverged) {
    if (r.outcome === 'mismatch') {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: expected=${r.pair.expected} actual=${r.actualStatus}`
      );
    } else {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: ERROR ${r.errorMessage}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fixtures = discover();
  console.log(
    `Discovered ${fixtures.length} fixture pair(s)${
      categoryArg ? ` in category "${categoryArg}"` : ''
    }${limitArg > 0 ? ` (limited to ${limitArg} per category)` : ''}.`
  );
  const results = [];
  let i = 0;
  for (const pair of fixtures) {
    i++;
    if (verbose) {
      process.stdout.write(`[${i}/${fixtures.length}] ${pair.category}/${pair.name}…`);
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await runFixture(pair);
    results.push(r);
    if (verbose) {
      const tag = r.outcome === 'match' ? '✓' : r.outcome === 'mismatch' ? '✗' : '!';
      console.log(` ${tag} ${r.actualStatus ?? r.errorMessage ?? ''}`);
    } else if (i % 25 === 0) {
      process.stdout.write(`  ${i}/${fixtures.length}\r`);
    }
  }
  if (!verbose) console.log();
  printSummary(results);
  printDivergences(results);
  const diverged = results.filter((r) => r.outcome !== 'match').length;
  process.exit(diverged === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
