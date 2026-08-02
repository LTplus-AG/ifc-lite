/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Data discovery for the lens system.
 *
 * Two-phase approach for zero loading impact:
 * 1. `discoverClasses()` — instant, reads unique type names from entity table
 *    (O(n) array scan, zero STEP parsing). Called when models load.
 * 2. `discoverDataSources()` — expensive, samples entities for psets/quantities/
 *    materials/classifications. Called lazily when user opens a dropdown.
 */

import type { LensDataProvider } from './types.js';

/** Max entities to sample per type for property/quantity discovery */
const SAMPLE_SIZE = 30;

/** Result of lens data discovery */
export interface DiscoveredLensData {
  /** All IFC class names found in loaded models, sorted alphabetically */
  classes: string[];
  /** Property set names → property names (sorted). Null = not yet discovered. */
  propertySets: Map<string, string[]> | null;
  /** Quantity set names → quantity names (sorted). Null = not yet discovered. */
  quantitySets: Map<string, string[]> | null;
  /** Classification system names found. Null = not yet discovered. */
  classificationSystems: string[] | null;
  /** Material names found. Null = not yet discovered. */
  materials: string[] | null;
}

/**
 * Discover IFC classes from loaded models — INSTANT.
 *
 * O(n) scan of entity type names only. No STEP buffer parsing.
 * Typically <5ms for 100k entities.
 */
export function discoverClasses(provider: LensDataProvider): string[] {
  const classSet = new Set<string>();
  provider.forEachEntity((globalId) => {
    const typeName = provider.getEntityType(globalId);
    if (typeName) classSet.add(typeName);
  });
  return Array.from(classSet).sort();
}

/**
 * Discover data sources by sampling entities — EXPENSIVE.
 *
 * Samples up to SAMPLE_SIZE entities per type to collect property sets,
 * quantity sets, classification systems, and material names.
 * Only call when the user actively needs this data (e.g., opens a dropdown).
 */
export function discoverDataSources(
  provider: LensDataProvider,
  categories: {
    properties?: boolean;
    quantities?: boolean;
    classifications?: boolean;
    materials?: boolean;
  },
): Partial<Pick<DiscoveredLensData, 'propertySets' | 'quantitySets' | 'classificationSystems' | 'materials'>> {
  const result: Partial<Pick<DiscoveredLensData, 'propertySets' | 'quantitySets' | 'classificationSystems' | 'materials'>> = {};

  const needsProperties = categories.properties === true;
  const needsQuantities = categories.quantities === true;
  const needsClassifications = categories.classifications === true;
  const needsMaterials = categories.materials === true;

  if (!needsProperties && !needsQuantities && !needsClassifications && !needsMaterials) {
    return result;
  }

  const propertySets = needsProperties ? new Map<string, Set<string>>() : null;
  const quantitySets = needsQuantities ? new Map<string, Set<string>>() : null;
  const classificationSystems = needsClassifications ? new Set<string>() : null;
  const materials = needsMaterials ? new Set<string>() : null;

  // Collect sample IDs grouped by type
  const sampleIds: number[] = [];
  const seenPerType = new Map<string, number>();

  provider.forEachEntity((globalId) => {
    const typeName = provider.getEntityType(globalId);
    if (!typeName) return;
    const count = seenPerType.get(typeName) ?? 0;
    if (count < SAMPLE_SIZE) {
      sampleIds.push(globalId);
      seenPerType.set(typeName, count + 1);
    }
  });

  // Sample entities
  for (const globalId of sampleIds) {
    if (propertySets) {
      const psets = provider.getPropertySets(globalId);
      for (const pset of psets) {
        if (!pset.name) continue;
        let propNames = propertySets.get(pset.name);
        if (!propNames) {
          propNames = new Set();
          propertySets.set(pset.name, propNames);
        }
        for (const prop of pset.properties) {
          if (prop.name) propNames.add(prop.name);
        }
      }
    }

    if (quantitySets && provider.getQuantitySets) {
      const qsets = provider.getQuantitySets(globalId);
      for (const qset of qsets) {
        if (!qset.name) continue;
        let quantNames = quantitySets.get(qset.name);
        if (!quantNames) {
          quantNames = new Set();
          quantitySets.set(qset.name, quantNames);
        }
        for (const q of qset.quantities) {
          if (q.name) quantNames.add(q.name);
        }
      }
    }

    if (classificationSystems && provider.getClassifications) {
      const cls = provider.getClassifications(globalId);
      for (const c of cls) {
        if (c.system) classificationSystems.add(c.system);
      }
    }

    if (materials) {
      // Prefer individual material names so the rule dropdown offers real
      // materials (e.g. "Gypsum", "Insulation") rather than the layer-set /
      // family-type string. Fall back to the single name. (#1366)
      if (provider.getMaterialNames) {
        for (const n of provider.getMaterialNames(globalId)) {
          if (n) materials.add(n);
        }
      } else if (provider.getMaterialName) {
        const mat = provider.getMaterialName(globalId);
        if (mat) materials.add(mat);
      }
    }
  }

  // Convert sets to sorted arrays
  if (propertySets) {
    const psResult = new Map<string, string[]>();
    for (const [name, propSet] of propertySets) {
      psResult.set(name, Array.from(propSet).sort());
    }
    result.propertySets = psResult;
  }

  if (quantitySets) {
    const qsResult = new Map<string, string[]>();
    for (const [name, quantSet] of quantitySets) {
      qsResult.set(name, Array.from(quantSet).sort());
    }
    result.quantitySets = qsResult;
  }

  if (classificationSystems) {
    result.classificationSystems = Array.from(classificationSystems).sort();
  }

  if (materials) {
    result.materials = Array.from(materials).sort();
  }

  return result;
}
