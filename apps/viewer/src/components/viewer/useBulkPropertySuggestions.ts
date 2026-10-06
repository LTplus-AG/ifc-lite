/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Property-set and property name suggestions for the Bulk editor, split from `BulkPropertyEditor.tsx` for its module-size budget. */

import { useEffect, useMemo, useState } from 'react';
import { extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import type { BulkTargetSource } from './bulk-targets';

export function useBulkPropertySuggestions(targetSource: BulkTargetSource, selectedModel: { ifcDataStore?: IfcDataStore | null } | undefined,
  queryIds: readonly number[], targetPset: string): { psetOptions: string[]; propOptions: string[] } {
  const [discoveredProperties, setDiscoveredProperties] = useState<{
    psets: Map<string, Set<string>>; allProps: Set<string>;
  }>({ psets: new Map(), allProps: new Set() });

  // Property suggestions are display-only; evaluate the query once via Rules,
  // then sample its matches without re-running the old property predicate.
  useEffect(() => {
    const psets = new Map<string, Set<string>>();
    const allProps = new Set<string>();
    const dataStore = selectedModel?.ifcDataStore;
    if (targetSource === 'query' && dataStore && queryIds.length > 0) {
      // Re-parsing the source is costly; use one sample for lazy stores and
      // the cached columnar table for the rest of the suggestions.
      let firstProperties: Array<{ name: string; properties: Array<{ name: string }> }> =
        dataStore.properties?.getForEntity(queryIds[0]) ?? [];
      if (dataStore.onDemandPropertyMap && dataStore.source?.length > 0) {
        try {
          firstProperties = extractPropertiesOnDemand(dataStore as IfcDataStore, queryIds[0]);
        } catch (error) {
          console.warn('[bulk-edit] property suggestions unavailable', error);
        }
      }
      for (const [index, entityId] of queryIds.slice(0, 100).entries()) {
        const properties = index === 0 ? firstProperties : dataStore.properties?.getForEntity(entityId) ?? [];
        for (const pset of properties) {
          const propSet = psets.get(pset.name) ?? new Set<string>();
          for (const prop of pset.properties) {
            propSet.add(prop.name);
            allProps.add(prop.name);
          }
          psets.set(pset.name, propSet);
        }
      }
    }
    setDiscoveredProperties({ psets, allProps });
  }, [targetSource, selectedModel, queryIds]);


  // Flatten discovered properties for selectors
  const psetOptions = useMemo(() => {
    return Array.from(discoveredProperties.psets.keys()).sort();
  }, [discoveredProperties]);

  const propOptions = useMemo(() => {
    // If a property set is selected, show only properties from that set
    if (targetPset && discoveredProperties.psets.has(targetPset)) {
      return Array.from(discoveredProperties.psets.get(targetPset)!).sort();
    }
    // Otherwise show all properties
    return Array.from(discoveredProperties.allProps).sort();
  }, [discoveredProperties, targetPset]);

  return { psetOptions, propOptions };
}
