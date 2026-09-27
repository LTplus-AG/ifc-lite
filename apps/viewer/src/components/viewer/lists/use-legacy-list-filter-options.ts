/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ListDataProvider, UnreadableListCondition } from '@ifc-lite/lists';
import { collectSpatialContainerNames } from '@/utils/spatialHierarchy';
import { discoverFilterStoreys } from '@/lib/search/filter-schema';
import { discoverConditionValues, type ListConditionValues, type StoreWithView } from './list-builder-discovery';
import { isEditableCondition } from '@/lib/lists/compatibility-condition';

/** The provider-only List filter editor keeps suggestions from every loaded
 * model. The shared Rules editor samples the active model for its own rules. */
export function useLegacyListFilterOptions(
  rows: readonly UnreadableListCondition[],
  stores: readonly IfcDataStore[],
  storeViews: readonly StoreWithView[],
  providers: readonly ListDataProvider[],
  mutationVersion: number,
) {
  const [sampled, setSampled] = useState<{
    version: number; source: readonly StoreWithView[]; values: ListConditionValues;
  } | null>(null);
  const values = sampled?.version === mutationVersion && sampled.source === storeViews ? sampled.values : null;
  useEffect(() => {
    if (values || stores.length === 0) return;
    const needs = rows.some((row) => isEditableCondition(row) && (
      row.condition.source === 'property' || row.condition.source === 'material' || row.condition.source === 'classification'
    ));
    if (needs) setSampled({ version: mutationVersion, source: storeViews, values: discoverConditionValues(storeViews) });
  }, [values, stores, rows, mutationVersion, storeViews]);

  const storeyNames = useMemo(() => {
    const names = new Set<string>();
    for (const { store, view } of storeViews) {
      for (const [name] of discoverFilterStoreys(store, view)) names.add(name);
    }
    return [...names].sort();
  }, [storeViews, mutationVersion]);

  const spatialNames = useMemo<Record<string, string[]>>(() => {
    const byLevel = {
      Container: new Set<string>(), Storey: new Set(storeyNames), Building: new Set<string>(),
      Site: new Set<string>(), Project: new Set<string>(),
    };
    for (const store of stores) {
      const names = collectSpatialContainerNames(store.spatialHierarchy, (id) => store.entities.getName(id));
      names.containers.forEach((name) => byLevel.Container.add(name));
      names.buildings.forEach((name) => byLevel.Building.add(name));
      names.sites.forEach((name) => byLevel.Site.add(name));
      names.projects.forEach((name) => byLevel.Project.add(name));
    }
    return Object.fromEntries(Object.entries(byLevel).map(([level, names]) => [level, [...names].sort()]));
  }, [stores, storeyNames]);

  const modelNames = useMemo(() => {
    const names = new Set<string>();
    for (const provider of providers) {
      const name = provider.getModelName?.();
      if (name) names.add(name);
    }
    return [...names].sort();
  }, [providers]);

  return { values, spatialNames, modelNames };
}
