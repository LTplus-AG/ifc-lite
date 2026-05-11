/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids <file.ifc> <rules.ids> [options]
 *
 * Validate an IFC file against IDS (Information Delivery Specification) rules.
 */

import { readFile } from 'node:fs/promises';
import { createHeadlessContext, loadIfcFile } from '../loader.js';
import { printJson, formatTable, hasFlag, getFlag, fatal } from '../output.js';
import type { IfcDataStore } from '@ifc-lite/parser';
import { EntityNode } from '@ifc-lite/query';
import {
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractAllEntityAttributes,
  extractTypeEntityOwnProperties,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

export async function idsCommand(args: string[]): Promise<void> {
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional.length < 2) fatal('Usage: ifc-lite ids <file.ifc> <rules.ids> [--json]');

  const [ifcPath, idsPath] = positional;
  const jsonOutput = hasFlag(args, '--json');
  const locale = (getFlag(args, '--locale') ?? 'en') as 'en' | 'de' | 'fr';

  const { bim, store } = await createHeadlessContext(ifcPath);

  // Read IDS file
  const idsContent = await readFile(idsPath, 'utf-8');

  // Parse and validate
  const idsDoc = await bim.ids.parse(idsContent);

  // Build accessor for validation
  const accessor = buildIdsAccessor(store);

  const report = await bim.ids.validate(idsDoc, {
    accessor,
    modelInfo: { schemaVersion: store.schemaVersion },
    locale,
    onProgress: (p) => {
      if (!jsonOutput) {
        process.stderr.write(`\r  Validating: ${p.specName} (${p.current}/${p.total})`);
      }
    },
  });

  if (!jsonOutput) process.stderr.write('\n');

  const summary = bim.ids.summarize(report as { specificationResults: Array<{ entityResults: Array<{ passed: boolean }> }> });

  if (jsonOutput) {
    printJson({ summary, report });
    return;
  }

  process.stdout.write(`\n  IDS Validation Results\n`);
  process.stdout.write(`  ─────────────────────\n`);
  process.stdout.write(`  Specifications: ${summary.passedSpecifications}/${summary.totalSpecifications} passed\n`);
  process.stdout.write(`  Entities:       ${summary.passedEntities}/${summary.totalEntities} passed\n`);
  process.stdout.write(`  Failed:         ${summary.failedEntities} entities in ${summary.failedSpecifications} specs\n`);

  const exitCode = summary.failedSpecifications > 0 ? 1 : 0;
  process.stdout.write(`\n  Result: ${exitCode === 0 ? 'PASS' : 'FAIL'}\n\n`);
  process.exitCode = exitCode;
}

const REL_TYPE_MAP: Record<string, RelationshipType> = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates, // closest mapping
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

/**
 * Build a complete IFCDataAccessor for the IDS validator.
 * Implements all 12+ methods the validator expects.
 */
function buildIdsAccessor(store: IfcDataStore): unknown {
  return {
    getEntityType(expressId: number): string | undefined {
      return store.entities.getTypeName(expressId) || undefined;
    },
    getEntityName(expressId: number): string | undefined {
      const node = new EntityNode(store, expressId);
      return node.name || undefined;
    },
    getGlobalId(expressId: number): string | undefined {
      const node = new EntityNode(store, expressId);
      return node.globalId || undefined;
    },
    getDescription(expressId: number): string | undefined {
      const node = new EntityNode(store, expressId);
      return node.description || undefined;
    },
    getObjectType(expressId: number): string | undefined {
      // Try EntityNode's objectType first (works for IfcObject subtypes)
      const node = new EntityNode(store, expressId);
      if (node.objectType) return node.objectType;

      // For IfcTypeObject subtypes (IfcWallType, etc.), extract PredefinedType
      // from entity attributes since they don't have ObjectType.
      const allAttrs = extractAllEntityAttributes(store, expressId);
      const predefinedType = allAttrs.find(a => a.name === 'PredefinedType');
      if (predefinedType?.value && predefinedType.value !== 'NOTDEFINED') {
        return typeof predefinedType.value === 'string' ? predefinedType.value : String(predefinedType.value);
      }

      // If PredefinedType is USERDEFINED/absent, check ObjectType from full attributes
      const objTypeAttr = allAttrs.find(a => a.name === 'ObjectType');
      if (objTypeAttr?.value) {
        return typeof objTypeAttr.value === 'string' ? objTypeAttr.value : String(objTypeAttr.value);
      }

      return undefined;
    },
    getEntitiesByType(typeName: string): number[] {
      const upper = typeName.toUpperCase();
      return [...(store.entityIndex.byType.get(upper) ?? [])];
    },
    getAllEntityIds(): number[] {
      const ids: number[] = [];
      for (const [, typeIds] of store.entityIndex.byType) {
        for (const id of typeIds) ids.push(id);
      }
      return ids;
    },
    getPropertyValue(expressId: number, propertySetName: string, propertyName: string) {
      const node = new EntityNode(store, expressId);
      const psets = node.properties();
      for (const pset of psets) {
        if (pset.name === propertySetName) {
          for (const prop of pset.properties) {
            if (prop.name === propertyName) {
              return {
                value: prop.value ?? null,
                dataType: prop.type ?? 'IFCLABEL',
                propertySetName: pset.name,
                propertyName: prop.name,
              };
            }
          }
        }
      }
      return undefined;
    },
    getPropertySets(expressId: number) {
      // Try EntityNode first (relationship-based properties for IfcObject instances)
      const node = new EntityNode(store, expressId);
      const psets = node.properties();

      const mapPsets = (rawPsets: Array<{ name: string; properties: Array<{ name: string; type: unknown; value: unknown }> }>) =>
        rawPsets.map(pset => ({
          name: pset.name,
          properties: pset.properties.map(p => ({
            name: p.name,
            value: p.value ?? null,
            dataType: p.type ?? 'IFCLABEL',
          })),
        }));

      if (psets.length > 0) {
        return mapPsets(psets);
      }

      // For IfcTypeObject subtypes, extract from HasPropertySets attribute
      const typePsets = extractTypeEntityOwnProperties(store, expressId);
      if (typePsets.length > 0) {
        return mapPsets(typePsets);
      }

      return [];
    },
    getClassifications(expressId: number) {
      const classifications = extractClassificationsOnDemand(store, expressId);
      return classifications.map(c => ({
        system: c.system ?? '',
        value: c.identification ?? '',
        name: c.name ?? undefined,
      }));
    },
    getMaterials(expressId: number) {
      const materialData = extractMaterialsOnDemand(store, expressId);
      if (!materialData) return [];
      const materials: Array<{ name: string; category?: string }> = [];
      if (materialData.name) {
        materials.push({ name: materialData.name });
      }
      if (materialData.layers) {
        for (const layer of materialData.layers) {
          if (layer.materialName) {
            materials.push({ name: layer.materialName, category: layer.category ?? undefined });
          }
        }
      }
      return materials;
    },
    getParent(expressId: number, relationType: string) {
      const relEnum = REL_TYPE_MAP[relationType];
      if (relEnum === undefined) return undefined;
      const parents = store.relationships.getRelated(expressId, relEnum, 'inverse');
      if (parents.length === 0) return undefined;
      const parentId = parents[0];
      const parentType = store.entities.getTypeName(parentId);
      // Extract predefinedType from parent entity attributes
      const parentAttrs = extractAllEntityAttributes(store, parentId);
      const parentPredefined = parentAttrs.find(a => a.name === 'PredefinedType');
      const predefinedType = parentPredefined?.value && parentPredefined.value !== 'NOTDEFINED'
        ? parentPredefined.value
        : undefined;

      return {
        expressId: parentId,
        entityType: parentType ?? '',
        predefinedType,
      };
    },
    getAttribute(expressId: number, attributeName: string): string | undefined {
      const node = new EntityNode(store, expressId);
      switch (attributeName) {
        case 'Name': return node.name || undefined;
        case 'Description': return node.description || undefined;
        case 'ObjectType': return node.objectType || undefined;
        case 'GlobalId': return node.globalId || undefined;
        case 'Tag': return node.tag || undefined;
        default: {
          // Fall back to full attribute extraction
          const attrs = extractAllEntityAttributes(store, expressId);
          const attr = attrs.find(a => a.name === attributeName);
          return attr?.value != null ? String(attr.value) : undefined;
        }
      }
    },
  };
}
