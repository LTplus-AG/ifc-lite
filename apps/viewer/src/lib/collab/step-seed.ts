/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP IFC → collab seed-source adapter (plan §4.2).
 *
 * `@ifc-lite/collab` stays parser-independent: its `seedFromStep` consumes a
 * minimal structural `StepSeedSource`. This adapter — which lives in the
 * viewer because the viewer owns the parser — walks a parsed `IfcDataStore`
 * and yields one `StepSeedEntity` per GUID-bearing (`IfcRoot`-derived) entity,
 * keyed by its stable `IfcGloballyUniqueId`.
 *
 * Future-aligned on IFCX/IFC5: even though the *source* is legacy STEP, the
 * seed is shaped as IFCX-native data — entities carry flat `bsi::ifc::*`
 * attributes and IFCX `children` for spatial containment. A recipient then
 * reconstructs the full model (spatial tree + properties) through the very
 * same IFCX path as a native IFC5 room (`snapshotToIfcx` → `parseIfcxViewerModel`),
 * with no STEP-specific reconstruction code.
 */

import {
  extractPropertiesOnDemand,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import type { ModelSlotRef, StepSeedEntity, StepSeedSource } from '@ifc-lite/collab';
import { LEGACY_ROOM_SLOT, roomSlotPath } from './model-slot-ref';

const IFC_CLASS_URI = (code: string) =>
  `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`;

const PROPERTY_TYPE_NAMES: Record<number, string> = {
  [PropertyValueType.String]: 'IfcText',
  [PropertyValueType.Real]: 'IfcReal',
  [PropertyValueType.Integer]: 'IfcInteger',
  [PropertyValueType.Boolean]: 'IfcBoolean',
  [PropertyValueType.Logical]: 'IfcLogical',
  [PropertyValueType.Label]: 'IfcLabel',
  [PropertyValueType.Identifier]: 'IfcIdentifier',
  [PropertyValueType.Text]: 'IfcText',
  [PropertyValueType.Enum]: 'IfcLabel',
  [PropertyValueType.Reference]: 'IfcLabel',
  [PropertyValueType.List]: 'IfcText',
};

/** A spatial-tree node as exposed on `IfcDataStore.spatialHierarchy.project`. */
interface SpatialNodeLike {
  expressId: number;
  elevation?: number;
  children: SpatialNodeLike[];
  elements: number[];
}

/**
 * Walk the parsed spatial hierarchy and build, per parent GUID path, the IFCX
 * `children` map (`childPath → childPath`) covering both spatial decomposition
 * (Project→Site→Building→Storey) and element containment. The key is arbitrary
 * for IFCX composition, so we reuse the child path.
 */
function buildChildrenByPath(
  store: IfcDataStore,
  pathFor: (expressId: number) => string | null,
): Map<string, Record<string, string>> {
  const byPath = new Map<string, Record<string, string>>();
  const root = (store.spatialHierarchy?.project ?? null) as SpatialNodeLike | null;
  if (!root) return byPath;

  const walk = (node: SpatialNodeLike) => {
    const parentPath = pathFor(node.expressId);
    if (parentPath) {
      const children: Record<string, string> = {};
      for (const child of node.children) {
        const cp = pathFor(child.expressId);
        if (cp) children[cp] = cp;
      }
      for (const elementId of node.elements) {
        const ep = pathFor(elementId);
        if (ep) children[ep] = ep;
      }
      if (Object.keys(children).length > 0) byPath.set(parentPath, children);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return byPath;
}

/**
 * Adapt a parsed STEP `IfcDataStore` into an IFCX-native collab `StepSeedSource`.
 * `slot` is the room slot the model is shared into (#4444): every path the
 * source carries — the `children` references — is qualified with it, and the
 * seeder must be handed the same slot so entity paths and references agree.
 * Omitted, the source is shaped for a single-model room (`/<guid>`).
 */
export function buildStepSeedSource(
  store: IfcDataStore,
  fileName?: string,
  slot: ModelSlotRef = LEGACY_ROOM_SLOT,
): StepSeedSource {
  const guidPathFor = (expressId: number): string | null => {
    const guid = store.entities.getGlobalId(expressId);
    return guid ? roomSlotPath(slot, guid) : null;
  };
  const childrenByPath = buildChildrenByPath(store, guidPathFor);
  const storeyElevations = store.spatialHierarchy?.storeyElevations;

  function* iterate(): Generator<StepSeedEntity> {
    for (const [expressId, ref] of store.entityIndex.byId.entries()) {
      // Resolve EVERYTHING root-attribute-shaped from the columnar entity
      // TABLE, never `extractEntityAttributesOnDemand`: the on-demand helper
      // re-parses the source buffer per call, and this loop visits every
      // entity in the model — on large STEP files that froze the browser
      // before the room was seeded (AGENTS.md: never call it in loops). The
      // table also carries GlobalId for geometric products the compact index
      // can't attribute-extract, so keying by the table is *more* complete.
      // (`Tag` has no table column; seed attributes are best-effort and it is
      // dropped rather than paying a per-entity re-parse.)
      const guid = store.entities.getGlobalId(expressId);
      // Only IfcRoot-derived entities carry a GUID — the CRDT key.
      if (!guid) continue;

      // Proper-cased class from the entity table; fall back to the raw
      // (UPPERCASE) STEP type for resource-level entities ('Unknown').
      const tableName = store.entities.getTypeName(expressId);
      const ifcClass = tableName && tableName !== 'Unknown' ? tableName : ref.type;

      // IFCX-native flat attributes.
      const attributes: Record<string, unknown> = {
        'bsi::ifc::class': { code: ifcClass, uri: IFC_CLASS_URI(ifcClass) },
      };
      const name = store.entities.getName(expressId);
      const description = store.entities.getDescription(expressId);
      const objectType = store.entities.getObjectType(expressId);
      const tag = store.entities.getTag?.(expressId);
      if (name) attributes['bsi::ifc::prop::Name'] = name;
      if (description) attributes['bsi::ifc::prop::Description'] = description;
      if (objectType) attributes['bsi::ifc::prop::ObjectType'] = objectType;
      if (tag) attributes['bsi::ifc::prop::Tag'] = tag;

      // Storey elevation drives the hierarchy builder's storey ordering.
      if (ifcClass === 'IfcBuildingStorey') {
        const elevation = storeyElevations?.get(expressId);
        if (typeof elevation === 'number') {
          attributes['bsi::ifc::prop::Elevation'] = elevation;
        }
      }

      // Structured carriers preserve exact set names and distinguish them
      // from IFCX display groups derived from ordinary root attributes.
      // IFC names are file-controlled. Null-prototype dictionaries preserve
      // legal names such as "__proto__" as ordinary data.
      const psets: NonNullable<StepSeedEntity['psets']> = Object.create(null);
      for (const pset of extractPropertiesOnDemand(store, expressId)) {
        for (const prop of pset.properties) {
          if (prop.value === null || prop.value === undefined) continue;
          const values = psets[pset.name] ?? (psets[pset.name] = Object.create(null));
          const value = Array.isArray(prop.value) ? JSON.stringify(prop.value) : prop.value;
          values[prop.name] = {
            type: prop.dataType ?? PROPERTY_TYPE_NAMES[prop.type] ?? 'IfcLabel',
            value,
          };
        }
      }
      const quantities: NonNullable<StepSeedEntity['quantities']> = Object.create(null);
      for (const qset of store.getQuantities?.(expressId) ?? store.quantities?.getForEntity?.(expressId) ?? []) {
        for (const quantity of qset.quantities) {
          const values = quantities[qset.name] ?? (quantities[qset.name] = Object.create(null));
          values[quantity.name] = quantity.value;
        }
      }

      // Classifications + materials → IFCX attributes (the recipient's
      // source-dependent cards can't run on a reconstructed store, so surface
      // these as property groups instead).
      for (const c of extractClassificationsOnDemand(store, expressId)) {
        const code = c.identification ?? c.name;
        if (c.system && code) attributes[`bsi::ifc::classification::${c.system}`] = code;
      }
      const material = extractMaterialsOnDemand(store, expressId);
      if (material?.name) attributes['bsi::ifc::material::Name'] = material.name;
      if (material?.layers && material.layers.length > 0) {
        const layerSummary = material.layers
          .map((l) => `${l.materialName ?? l.name ?? ''}${l.thickness ? ` (${l.thickness})` : ''}`)
          .filter((s) => s.trim().length > 0)
          .join(', ');
        if (layerSummary) attributes['bsi::ifc::material::Layers'] = layerSummary;
      }

      yield {
        guid,
        ifcClass,
        attributes,
        psets: Object.keys(psets).length ? psets : undefined,
        quantities: Object.keys(quantities).length ? quantities : undefined,
        children: childrenByPath.get(roomSlotPath(slot, guid)),
      };
    }
  }

  return {
    // A fresh iterator each time it's consumed (re-iterable).
    entities: { [Symbol.iterator]: iterate },
    header: { schema: store.schemaVersion, fileName },
  };
}
