/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Suggestions for List-value rules (#6190). Unlike the shared Rules editor,
 * which samples the active model, these come from every loaded model, as the
 * Lists editor always offered them: a federated list filters all of them. */
import { createContext, useEffect, useMemo, useState } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { DiscoveredColumns, ListDataProvider } from '@ifc-lite/lists';
import type { FilterGroup } from '@ifc-lite/rules';
import type { ZoneSet } from '@/lib/zones';
import { collectSpatialContainerNames } from '@/utils/spatialHierarchy';
import { discoverFilterStoreys } from '@/lib/search/filter-schema';
import { discoverConditionValues, type ListConditionValues, type StoreWithView } from './list-builder-discovery';

export interface ListValueOptions {
  /** Every pset/qto and its property/quantity names. */
  discovered: DiscoveredColumns;
  /** Sampled property, material and classification values; `null` until a rule needs them. */
  values: ListConditionValues | null;
  /** Names per spatial level (`Container`, `Storey`, `Building`, `Site`, `Project`). */
  spatialNames: Record<string, string[]>;
  modelNames: string[];
  zoneSets: readonly ZoneSet[];
}

/** Provided by the Lists builder around its Rules editor; absent elsewhere. */
export const ListValueOptionsContext = createContext<ListValueOptions | null>(null);

const SAMPLED_SOURCES = new Set(['property', 'material', 'classification']);

/** Whether a List-value rule in `groups` would show sampled value suggestions. */
export function groupsNeedListValues(groups: readonly FilterGroup[]): boolean {
  return groups.some((group) => group.rules.some((rule) => rule.kind === 'listCondition' && SAMPLED_SOURCES.has(rule.source)));
}

export function useListValueOptions(
  needsValues: boolean,
  stores: readonly IfcDataStore[],
  storeViews: readonly StoreWithView[],
  providers: readonly ListDataProvider[],
  mutationVersion: number,
): Pick<ListValueOptions, 'values' | 'spatialNames' | 'modelNames'> {
  const [sampled, setSampled] = useState<{
    version: number; source: readonly StoreWithView[]; values: ListConditionValues;
  } | null>(null);
  const values = sampled?.version === mutationVersion && sampled.source === storeViews ? sampled.values : null;
  useEffect(() => {
    if (values || stores.length === 0 || !needsValues) return;
    setSampled({ version: mutationVersion, source: storeViews, values: discoverConditionValues(storeViews) });
  }, [values, stores, needsValues, mutationVersion, storeViews]);

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

  return useMemo(() => ({ values, spatialNames, modelNames }), [values, spatialNames, modelNames]);
}
