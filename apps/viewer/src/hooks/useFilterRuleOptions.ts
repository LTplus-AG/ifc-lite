/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dropdown material a `RuleRow` needs: IFC types, storeys, pset/qto names
 * and distinct values for the active model.
 *
 * Lifted out of `SearchModal.filter.builder.tsx` when the clash panel started
 * building filter rows of its own (#3902). Discovery is cached in the search
 * slice per model, so several mounted builders share one scan — the clash rule
 * form alone mounts two of this hook (set A and set B) and the search modal can
 * be open behind it. Each effect therefore re-reads the cache from the LIVE
 * store rather than from the render's captured copy: instances that commit in
 * the same pass all see the same pre-update map, and the whole-model pset/qto
 * and value scans (which parse property sets on demand) would run once per
 * instance.
 */

import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { COMMON_IFC_TYPES } from '@/lib/search/common-ifc-types';
import type { FilterRule } from '@/lib/search/filter-rules';
import {
  discoverFilterSchema,
  discoverPropertyAndQuantitySchema,
  discoverFilterValues,
} from '@/lib/search/filter-schema';
import type { RuleRowProps } from '@/components/viewer/SearchModal.filter.editors';

/** Exactly the option props `RuleRow` takes, so a caller can spread this. */
export type FilterRuleOptions = Pick<
  RuleRowProps,
  'ifcTypeOptions' | 'storeyOptions' | 'psetQto' | 'valueSchema'
>;

export function useFilterRuleOptions(rules: readonly FilterRule[]): FilterRuleOptions {
  const {
    schemaMap,
    models,
    activeModelId,
    setFilterSchema,
    setFilterPsetQtoSchema,
    setFilterValueSchema,
  } = useViewerStore(
    useShallow((s) => ({
      schemaMap: s.searchFilterSchema,
      models: s.models,
      activeModelId: s.activeModelId,
      setFilterSchema: s.setFilterSchema,
      setFilterPsetQtoSchema: s.setFilterPsetQtoSchema,
      setFilterValueSchema: s.setFilterValueSchema,
    })),
  );

  const activeModel = activeModelId ? models.get(activeModelId) : undefined;
  const activeStore = activeModel?.ifcDataStore ?? null;
  const schemaEntry = activeModelId ? schemaMap.get(activeModelId) : undefined;

  // Cheap schema discovery — runs once per active model.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    if (useViewerStore.getState().searchFilterSchema.has(activeModelId)) return;
    setFilterSchema(activeModelId, discoverFilterSchema(activeStore));
  }, [activeModelId, activeStore, schemaMap, setFilterSchema]);

  // Lazy pset/qto schema — fired the first time a property/quantity rule appears.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    if (useViewerStore.getState().searchFilterSchema.get(activeModelId)?.psetQto) return;
    const needs = rules.some((r) => r.kind === 'property' || r.kind === 'quantity');
    if (!needs) return;
    setFilterPsetQtoSchema(activeModelId, discoverPropertyAndQuantitySchema(activeStore));
  }, [activeModelId, activeStore, rules, schemaMap, setFilterPsetQtoSchema]);

  // Lazy value discovery - distinct material / classification / property /
  // predefined-type values for the chip value suggestions. Fired the first time
  // a rule that benefits from them appears.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    if (useViewerStore.getState().searchFilterSchema.get(activeModelId)?.values) return;
    const needs = rules.some(
      (r) =>
        r.kind === 'property' ||
        r.kind === 'material' ||
        r.kind === 'classification' ||
        r.kind === 'predefinedType',
    );
    if (!needs) return;
    setFilterValueSchema(activeModelId, discoverFilterValues(activeStore));
  }, [activeModelId, activeStore, rules, schemaMap, setFilterValueSchema]);

  const ifcTypeOptions = useMemo<string[]>(() => {
    if (schemaEntry?.basic.ifcTypes && schemaEntry.basic.ifcTypes.length > 0) {
      return schemaEntry.basic.ifcTypes;
    }
    return COMMON_IFC_TYPES.slice();
  }, [schemaEntry]);

  // The canonical IFC types the rules select (ifcType "is one of" rules).
  const selectedTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of rules) {
      if (r.kind === 'ifcType' && r.op === 'in') {
        for (const v of r.values) if (v) set.add(v);
      }
    }
    return Array.from(set);
  }, [rules]);

  const hasPropOrQty = useMemo(
    () => rules.some((r) => r.kind === 'property' || r.kind === 'quantity'),
    [rules],
  );

  // Pset/Qto dropdown source: when the rules target specific IFC types, scope
  // discovery to just those elements so only their (legal + user-defined) psets
  // show - no scrolling past unrelated MEP/structural sets - and read them
  // directly so a pset missing from the on-demand map still appears. Otherwise
  // use the cached whole-model schema. (#1462)
  const psetQto = useMemo(() => {
    const cached = schemaEntry?.psetQto ?? null;
    if (!activeStore || !hasPropOrQty || selectedTypes.length === 0) return cached;
    return discoverPropertyAndQuantitySchema(activeStore, selectedTypes);
  }, [activeStore, hasPropOrQty, selectedTypes, schemaEntry?.psetQto]);

  return {
    ifcTypeOptions,
    storeyOptions: schemaEntry?.basic.storeys ?? [],
    psetQto,
    valueSchema: schemaEntry?.values ?? null,
  };
}
