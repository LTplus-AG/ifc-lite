/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.query namespace methods.
 */

import type { EntityData, EntityRef } from '@ifc-lite/sdk';
import type { NamespaceSchema } from './bridge-schema.js';
import { withAliases, toRef, mapNamedProperties } from './bridge-helpers.js';

export function buildQueryNamespace(): NamespaceSchema {
  return {
    name: 'query',
    doc: 'Query entities',
    permission: 'query',
    methods: [
      {
        name: 'all',
        doc: 'Get all entities',
        args: [],
        tsReturn: 'BimEntity[]',
        call: (sdk) => {
          return sdk.query().toArray().map(withAliases);
        },
        returns: 'value',
      },
      {
        name: 'byType',
        doc: "Filter by IFC type e.g. 'IfcWall'",
        args: ['...strings'],
        paramNames: ['types'],
        tsReturn: 'BimEntity[]',
        call: (sdk, args) => {
          const types = args[0] as string[];
          const builder = sdk.query();
          if (types.length > 0) builder.byType(...types);
          return builder.toArray().map(withAliases);
        },
        returns: 'value',
      },
      {
        name: 'entity',
        doc: 'Get entity by model ID and express ID',
        args: ['string', 'number'],
        paramNames: ['modelId', 'expressId'],
        tsReturn: 'BimEntity | null',
        call: (sdk, args) => {
          const modelId = args[0] as string;
          const expressId = args[1] as number;
          const entity = sdk.entity({ modelId, expressId });
          return entity ? withAliases(entity) : null;
        },
        returns: 'value',
      },
      {
        name: 'attributes',
        doc: 'Get all named string/enum attributes for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimAttribute[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.attributes(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect raw IFC occurrence attributes before guessing metadata names.',
        },
      },
      {
        name: 'properties',
        doc: 'Get all IfcPropertySet data for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimPropertySet[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.properties(ref).map(pset => {
            const mappedProperties = mapNamedProperties(pset.properties);
            return {
              name: pset.name, Name: pset.name,
              globalId: pset.globalId, GlobalId: pset.globalId,
              properties: mappedProperties,
              Properties: mappedProperties,
            };
          });
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect all property sets on an occurrence before guessing individual property names.',
        },
      },
      {
        name: 'quantities',
        doc: 'Get all IfcElementQuantity data for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimQuantitySet[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.quantities(ref).map(qset => {
            const mappedQuantities = mapNamedProperties(qset.quantities);
            return {
              name: qset.name, Name: qset.name,
              quantities: mappedQuantities,
              Quantities: mappedQuantities,
            };
          });
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect all quantity sets on an occurrence.',
        },
      },
      {
        name: 'property',
        doc: 'Get a single property value from an entity',
        args: ['dump', 'string', 'string'],
        paramNames: ['entity', 'psetName', 'propName'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'string | number | boolean | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          return sdk.property(ref, args[1] as string, args[2] as string);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Read one known property when you already know the exact property-set and property names.',
        },
      },
      {
        name: 'classifications',
        doc: 'Get classification references for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimClassification[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.classifications(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Read relationship-based classification references.',
          cautions: ['Prefer this over guessing ad-hoc classification property names.'],
        },
      },
      {
        name: 'materials',
        doc: 'Get material assignment for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimMaterial | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          return sdk.materials(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Read assigned material data for an entity.',
          cautions: ['Prefer this over querying Pset_MaterialCommon or Material.Name as ordinary property sets.'],
        },
      },
      {
        name: 'typeProperties',
        doc: 'Get type-level property sets for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimTypeProperties | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          return sdk.typeProperties(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect type-level properties when occurrence-level property sets are missing expected data.',
        },
      },
      {
        name: 'documents',
        doc: 'Get linked document references for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimDocument[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.documents(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect linked document references and external documentation.',
        },
      },
      {
        name: 'relationships',
        doc: 'Get structural relationship summary for an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimRelationships',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return { voids: [], fills: [], groups: [], connections: [] };
          return sdk.relationships(ref);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect structural and semantic relationships such as voids, fills, groups, and connections.',
        },
      },
      {
        name: 'quantity',
        doc: 'Get a single quantity value from an entity',
        args: ['dump', 'string', 'string'],
        paramNames: ['entity', 'qsetName', 'quantityName'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'number | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          return sdk.quantity(ref, args[1] as string, args[2] as string);
        },
        returns: 'value',
      },
      {
        name: 'related',
        doc: 'Get related entities by IFC relationship type',
        args: ['dump', 'string', 'string'],
        paramNames: ['entity', 'relType', 'direction'],
        tsParamTypes: ['BimEntity', undefined, "'forward' | 'inverse'"],
        tsReturn: 'BimEntity[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.related(ref, args[1] as string, args[2] as 'forward' | 'inverse').map(withAliases);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Traverse a known IFC relationship type in forward or inverse direction.',
        },
      },
      {
        name: 'containedIn',
        doc: 'Get the spatial container of an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          const entity = sdk.containedIn(ref);
          return entity ? withAliases(entity) : null;
        },
        returns: 'value',
      },
      {
        name: 'contains',
        doc: 'Get entities contained in a spatial container',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.contains(ref).map(withAliases);
        },
        returns: 'value',
      },
      {
        name: 'decomposedBy',
        doc: 'Get the parent aggregate of an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          const entity = sdk.decomposedBy(ref);
          return entity ? withAliases(entity) : null;
        },
        returns: 'value',
      },
      {
        name: 'decomposes',
        doc: 'Get aggregated children of an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.decomposes(ref).map(withAliases);
        },
        returns: 'value',
      },
      {
        name: 'storey',
        doc: 'Get the containing building storey of an entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity | null',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return null;
          const entity = sdk.storey(ref);
          return entity ? withAliases(entity) : null;
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Resolve which building storey currently contains an entity.',
        },
      },
      {
        name: 'path',
        doc: 'Get the spatial/aggregation path from project to entity',
        args: ['dump'],
        paramNames: ['entity'],
        tsParamTypes: ['BimEntity'],
        tsReturn: 'BimEntity[]',
        call: (sdk, args) => {
          const ref = toRef(args[0]);
          if (!ref) return [];
          return sdk.path(ref).map(withAliases);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect the full project-to-entity spatial path before generating hierarchy-aware edits.',
        },
      },
      {
        name: 'storeys',
        doc: 'List all building storeys',
        args: [],
        tsReturn: 'BimEntity[]',
        call: (sdk) => {
          return sdk.storeys().map(withAliases);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'List all building storeys and use their actual names/elevations as generation targets.',
        },
      },
      {
        name: 'selection',
        doc: 'Get the current viewer selection as entities',
        args: [],
        tsReturn: 'BimEntity[]',
        call: (sdk) => {
          return sdk.viewer.getSelection()
            .map((ref) => sdk.entity(ref))
            .filter((entity): entity is EntityData => Boolean(entity))
            .map(withAliases);
        },
        returns: 'value',
        llmSemantics: {
          taskTags: ['inspect', 'repair'],
          inspectFirst: true,
          useWhen: 'Inspect what the user currently selected in the viewer before proposing targeted edits or analysis.',
        },
      },
    ],
  };
}
