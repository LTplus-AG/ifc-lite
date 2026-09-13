/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Column discovery - discovers available properties and quantities from model data.
 *
 * PERF: Samples a subset of entities per type to avoid scanning 100K+ entities.
 */

import type { IfcTypeEnum } from '@ifc-lite/data';
import type { ListDataProvider, DiscoveredColumns } from './types.js';
import { ENTITY_ATTRIBUTES } from './entity-attributes.js';

/** Max entities to sample per type per provider for column discovery */
const SAMPLE_SIZE = 50;

/**
 * Discover available columns for a set of entity types across one or more data providers.
 * Samples entities to find all property sets and quantity sets available.
 */
export function discoverColumns(
  providers: ListDataProvider | ListDataProvider[],
  entityTypes: IfcTypeEnum[],
): DiscoveredColumns {
  const providerList = Array.isArray(providers) ? providers : [providers];
  const properties = new Map<string, Set<string>>();
  const quantities = new Map<string, Set<string>>();

  for (const provider of providerList) {
    for (const type of entityTypes) {
      const ids = provider.getEntitiesByType(type);
      // Sample up to SAMPLE_SIZE entities per type per provider
      const sampleCount = Math.min(ids.length, SAMPLE_SIZE);

      for (let i = 0; i < sampleCount; i++) {
        const entityId = ids[i];

        // Discover properties
        const psets = provider.getPropertySets(entityId);
        for (const pset of psets) {
          if (!pset.name) continue;
          let propNames = properties.get(pset.name);
          if (!propNames) {
            propNames = new Set();
            properties.set(pset.name, propNames);
          }
          for (const prop of pset.properties) {
            if (prop.name) propNames.add(prop.name);
          }
        }

        // Discover quantities
        const qsets = provider.getQuantitySets(entityId);
        for (const qset of qsets) {
          if (!qset.name) continue;
          let quantNames = quantities.get(qset.name);
          if (!quantNames) {
            quantNames = new Set();
            quantities.set(qset.name, quantNames);
          }
          for (const quant of qset.quantities) {
            if (quant.name) quantNames.add(quant.name);
          }
        }
      }
    }
  }

  // Convert Sets to sorted arrays for stable UI
  const propertiesResult = new Map<string, string[]>();
  for (const [psetName, propSet] of properties) {
    propertiesResult.set(psetName, Array.from(propSet).sort());
  }

  const quantitiesResult = new Map<string, string[]>();
  for (const [qsetName, quantSet] of quantities) {
    quantitiesResult.set(qsetName, Array.from(quantSet).sort());
  }

  return {
    attributes: [...ENTITY_ATTRIBUTES],
    properties: propertiesResult,
    quantities: quantitiesResult,
  };
}
