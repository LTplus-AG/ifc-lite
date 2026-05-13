/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared test helpers for facet tests
 */

import type {
  IFCDataAccessor,
  PartOfRelation,
  PropertySetInfo,
  ClassificationInfo,
  MaterialInfo,
  ParentInfo,
  PropertyValueResult,
} from '../types.js';

interface MockEntity {
  expressId: number;
  type: string;
  name?: string;
  globalId?: string;
  description?: string;
  objectType?: string;
  properties?: Array<{
    psetName: string;
    propName: string;
    value: string | number | boolean | null;
    dataType?: string;
  }>;
  classifications?: Array<{ system?: string; value?: string }>;
  materials?: Array<{ name: string; category?: string }>;
  parent?: { expressId?: number; type: string; relation: string; predefinedType?: string };
  attributes?: Record<string, string | number | boolean>;
  /**
   * Optional per-attribute XSD-type metadata, mirroring the schema
   * lookup the production accessor performs via `getAttributeXsdTypes`.
   * Lets attribute-facet tests exercise the strict-cast gate.
   */
  attributeXsdTypes?: Record<string, readonly string[]>;
}

export function createMockAccessor(entities: MockEntity[]): IFCDataAccessor {
  const entityMap = new Map(entities.map((e) => [e.expressId, e]));

  return {
    getEntityType(expressId: number): string | undefined {
      return entityMap.get(expressId)?.type;
    },
    getEntityName(expressId: number): string | undefined {
      return entityMap.get(expressId)?.name;
    },
    getGlobalId(expressId: number): string | undefined {
      return entityMap.get(expressId)?.globalId;
    },
    getDescription(expressId: number): string | undefined {
      return entityMap.get(expressId)?.description;
    },
    getObjectType(expressId: number): string | undefined {
      return entityMap.get(expressId)?.objectType;
    },
    getEntitiesByType(typeName: string): number[] {
      const upper = typeName.toUpperCase();
      return entities
        .filter((e) => e.type.toUpperCase() === upper)
        .map((e) => e.expressId);
    },
    getAllEntityIds(): number[] {
      return entities.map((e) => e.expressId);
    },
    getPropertyValue(
      expressId: number,
      propertySetName: string,
      propertyName: string
    ): PropertyValueResult | undefined {
      const entity = entityMap.get(expressId);
      if (!entity?.properties) return undefined;
      const prop = entity.properties.find(
        (p) =>
          p.psetName.toUpperCase() === propertySetName.toUpperCase() &&
          p.propName.toUpperCase() === propertyName.toUpperCase()
      );
      if (!prop) return undefined;
      return {
        value: prop.value,
        dataType: prop.dataType || 'IFCLABEL',
        propertySetName: prop.psetName,
        propertyName: prop.propName,
      };
    },
    getPropertySets(expressId: number): PropertySetInfo[] {
      const entity = entityMap.get(expressId);
      if (!entity?.properties) return [];
      const psetMap = new Map<string, PropertySetInfo>();
      for (const prop of entity.properties) {
        let pset = psetMap.get(prop.psetName);
        if (!pset) {
          pset = { name: prop.psetName, properties: [] };
          psetMap.set(prop.psetName, pset);
        }
        pset.properties.push({
          name: prop.propName,
          value: prop.value,
          dataType: prop.dataType || 'IFCLABEL',
        });
      }
      return Array.from(psetMap.values());
    },
    getClassifications(expressId: number): ClassificationInfo[] {
      const entity = entityMap.get(expressId);
      if (!entity?.classifications) return [];
      return entity.classifications.map((c) => ({
        system: c.system || '',
        value: c.value || '',
      }));
    },
    getMaterials(expressId: number): MaterialInfo[] {
      const entity = entityMap.get(expressId);
      if (!entity?.materials) return [];
      return entity.materials;
    },
    getParent(
      expressId: number,
      relationType: PartOfRelation
    ): ParentInfo | undefined {
      const entity = entityMap.get(expressId);
      if (!entity?.parent) return undefined;
      if (entity.parent.relation !== relationType) return undefined;
      if (entity.parent.expressId == null) return undefined;
      return {
        expressId: entity.parent.expressId,
        entityType: entity.parent.type,
        predefinedType: entity.parent.predefinedType,
      };
    },
    getAttribute(
      expressId: number,
      attributeName: string
    ): string | number | boolean | undefined {
      const entity = entityMap.get(expressId);
      if (!entity?.attributes) return undefined;
      return entity.attributes[attributeName];
    },
    getAttributeXsdTypes(
      expressId: number,
      attributeName: string
    ): readonly string[] | undefined {
      const entity = entityMap.get(expressId);
      return entity?.attributeXsdTypes?.[attributeName];
    },
  };
}
