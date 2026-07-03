/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Material totals panel — shown when a material is selected from the
 * "Materials" hierarchy tab. Surfaces the material's own property sets
 * (IfcMaterialProperties) plus quantities aggregated across every element that
 * uses the material. Volumes/areas are apportioned by each element's material
 * share (layer thickness / constituent fraction), so a layered wall's volume is
 * split between its concrete and insulation rather than double-counted.
 */

import { useMemo } from 'react';
import { Layers, Calculator, Boxes, Info } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIfc } from '@/hooks/useIfc';
import { useViewerStore } from '@/store';
import {
  buildMaterialUsageIndex,
  getMaterialDisplay,
  extractMaterialPropertiesForMaterialId,
  extractQuantitiesOnDemand,
  extractProjectUnits,
  ProjectUnits,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { resolveQuantityDisplay } from '@/lib/units/display';
import { PropertySetCard } from './PropertySetCard';
import type { PropertySet } from './encodingUtils';

interface MaterialTotals {
  /** Number of elements using this material (across all loaded models). */
  elementCount: number;
  /** Elements that contributed at least one volume quantity. */
  elementsWithVolume: number;
  volume: number;
  hasVolume: boolean;
  area: number;
  hasArea: boolean;
  weight: number;
  hasWeight: boolean;
  /** Element count per IFC class, sorted desc. */
  byClass: Array<{ ifcClass: string; count: number }>;
}

/** Pick a quantity value by candidate names (case-insensitive), else by type. */
function pickQuantity(
  byName: Map<string, number>,
  candidates: string[],
): number | undefined {
  for (const c of candidates) {
    const v = byName.get(c);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Format an aggregated quantity with magnitude-appropriate precision. */
function formatNumber(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** Render an aggregated total with its resolved unit (issue #1573 follow-up):
 *  the display-unit override when set, else the file's declared/SI-default
 *  unit — same resolution as the property/quantity cards below, just with
 *  `formatNumber`'s magnitude-adaptive precision instead of `formatConverted`
 *  so large totals stay readable. NOTE: the totals loop sums raw quantity
 *  values across `allStores` (materials of the same name are merged across the
 *  federation), but the unit label + any override conversion here use only the
 *  SELECTED store's declared units. For a single-store model that is exact; a
 *  federation whose stores declare different volume/area/mass units mixes raw
 *  values before this label is applied — a pre-existing concern (the block was
 *  previously hardcoded m³/m²/kg) that this label does not attempt to fix. */
function formatTotal(
  value: number,
  quantityType: number,
  projectUnits: ProjectUnits,
  overrides: Record<string, string>,
): string {
  const disp = resolveQuantityDisplay(value, quantityType, projectUnits, overrides);
  const shown = disp.converted ?? value;
  return disp.unit ? `${formatNumber(shown)} ${disp.unit}` : formatNumber(shown);
}

export function MaterialTotalsPanel({ materialId, modelId }: { materialId: number; modelId: string }) {
  const { ifcDataStore, models } = useIfc();
  // Display-unit converter overrides (issue #1573 proposal 2).
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);

  // The store the selected material lives in, plus every loaded store (so the
  // totals merge same-named materials across a federation).
  const { selectedStore, allStores } = useMemo(() => {
    const stores: IfcDataStore[] = [];
    if (models.size > 0) {
      for (const [, m] of models) {
        if (m.ifcDataStore) stores.push(m.ifcDataStore as IfcDataStore);
      }
    } else if (ifcDataStore) {
      stores.push(ifcDataStore as IfcDataStore);
    }
    const sel = modelId !== 'legacy'
      ? (models.get(modelId)?.ifcDataStore as IfcDataStore | undefined) ?? (ifcDataStore as IfcDataStore | null) ?? undefined
      : (ifcDataStore as IfcDataStore | null) ?? undefined;
    return { selectedStore: sel, allStores: stores.length > 0 ? stores : (sel ? [sel] : []) };
  }, [models, ifcDataStore, modelId]);

  const display = useMemo(() => {
    if (!selectedStore) return { name: `Material #${materialId}`, type: 'IfcMaterial' };
    return getMaterialDisplay(selectedStore, materialId);
  }, [selectedStore, materialId]);

  // The material's own property sets (Pset_Material*).
  const psetGroups = useMemo(() => {
    if (!selectedStore) return [];
    return extractMaterialPropertiesForMaterialId(selectedStore, materialId);
  }, [selectedStore, materialId]);

  // The file's declared units, for rendering unit suffixes on material
  // property values (issue #1573).
  const projectUnits = useMemo(() => {
    if (!selectedStore?.source?.length || !selectedStore?.entityIndex) return ProjectUnits.empty();
    return extractProjectUnits(selectedStore.source, selectedStore.entityIndex);
  }, [selectedStore]);

  // Aggregate quantities across all elements using a material of this name.
  const totals = useMemo<MaterialTotals>(() => {
    const result: MaterialTotals = {
      elementCount: 0,
      elementsWithVolume: 0,
      volume: 0,
      hasVolume: false,
      area: 0,
      hasArea: false,
      weight: 0,
      hasWeight: false,
      byClass: [],
    };
    const classCounts = new Map<string, number>();
    const targetName = display.name;

    for (const store of allStores) {
      const usageIndex = buildMaterialUsageIndex(store);
      // Forward map of entity -> quantity-set ids (when on-demand parsing is
      // active). Used to skip the per-element extractor allocation for elements
      // that carry no quantities — the common case in large models, so a
      // material used by thousands of elements only pays the parse cost for the
      // subset that actually has Qto data.
      const qMap = store.onDemandQuantityMap;
      for (const usage of usageIndex.values()) {
        if (usage.name !== targetName) continue;
        for (const { entityId, weight } of usage.entries) {
          result.elementCount += 1;

          const ifcClass = store.entityIndex.byId.get(entityId)?.type || usage.ifcClass;
          classCounts.set(ifcClass, (classCounts.get(ifcClass) ?? 0) + 1);

          if (qMap && !qMap.get(entityId)?.length) continue; // no quantities — skip extraction
          const qsets = extractQuantitiesOnDemand(store, entityId);
          if (qsets.length === 0) continue;
          const volByName = new Map<string, number>();
          const areaByName = new Map<string, number>();
          const weightByName = new Map<string, number>();
          for (const qset of qsets) {
            for (const q of qset.quantities) {
              const key = q.name.toLowerCase();
              if (q.type === QuantityType.Volume) volByName.set(key, q.value);
              else if (q.type === QuantityType.Area) areaByName.set(key, q.value);
              else if (q.type === QuantityType.Weight) weightByName.set(key, q.value);
            }
          }

          const vol = pickQuantity(volByName, ['netvolume', 'grossvolume', 'volume'])
            ?? (volByName.size > 0 ? [...volByName.values()][0] : undefined);
          if (vol !== undefined) {
            result.volume += vol * weight;
            result.hasVolume = true;
            result.elementsWithVolume += 1;
          }

          const area = pickQuantity(areaByName, ['netarea', 'grossarea', 'netsidearea', 'grosssidearea', 'netfloorarea', 'grossfloorarea', 'area']);
          if (area !== undefined) {
            result.area += area * weight;
            result.hasArea = true;
          }

          const wt = pickQuantity(weightByName, ['netweight', 'grossweight', 'weight']);
          if (wt !== undefined) {
            result.weight += wt * weight;
            result.hasWeight = true;
          }
        }
      }
    }

    result.byClass = [...classCounts.entries()]
      .map(([ifcClass, count]) => ({ ifcClass, count }))
      .sort((a, b) => b.count - a.count);
    return result;
  }, [allStores, display.name]);

  const psetCount = psetGroups.reduce((sum, g) => sum + g.psets.length, 0);

  return (
    <div className="h-full flex flex-col border-l-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {/* Header */}
      <div className="p-4 border-b-2 border-zinc-200 dark:border-zinc-800 bg-amber-50/40 dark:bg-amber-950/20 space-y-2">
        <div className="flex items-start gap-3">
          <div className="p-2 border-2 border-amber-200 dark:border-amber-800 bg-white dark:bg-zinc-950 shrink-0">
            <Layers className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            <h3 className="font-bold text-sm truncate uppercase tracking-tight text-zinc-900 dark:text-zinc-100 min-w-0">
              {display.name}
            </h3>
            <p className="text-xs font-mono text-amber-600/80 dark:text-amber-400/80">{display.type}</p>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 bg-white dark:bg-black">
        <div className="p-3 space-y-3 w-full overflow-hidden">
          {/* Totals */}
          <div className="border-2 border-amber-200 dark:border-amber-800 bg-amber-50/20 dark:bg-amber-950/20">
            <div className="flex items-center gap-2 px-2.5 py-2 border-b-2 border-amber-200 dark:border-amber-800">
              <Calculator className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="font-bold text-xs text-amber-700 dark:text-amber-400 uppercase tracking-wide">Totals</span>
            </div>
            <div className="divide-y divide-amber-100 dark:divide-amber-900/30">
              <TotalRow label="Elements" value={totals.elementCount.toLocaleString()} />
              {totals.hasVolume && (
                <TotalRow label="Volume" value={formatTotal(totals.volume, QuantityType.Volume, projectUnits, unitDisplayOverrides)} />
              )}
              {totals.hasArea && (
                <TotalRow label="Area" value={formatTotal(totals.area, QuantityType.Area, projectUnits, unitDisplayOverrides)} />
              )}
              {totals.hasWeight && (
                <TotalRow label="Weight" value={formatTotal(totals.weight, QuantityType.Weight, projectUnits, unitDisplayOverrides)} />
              )}
            </div>
            {totals.elementCount > 0 && !totals.hasVolume && (
              <div className="flex items-start gap-1.5 px-2.5 py-2 text-[10px] text-zinc-500 dark:text-zinc-400 border-t border-amber-100 dark:border-amber-900/30">
                <Info className="h-3 w-3 shrink-0 mt-px" />
                <span>No volume quantities (Qto_*) found on these elements.</span>
              </div>
            )}
            {totals.hasVolume && totals.elementsWithVolume < totals.elementCount && (
              <div className="flex items-start gap-1.5 px-2.5 py-2 text-[10px] text-zinc-500 dark:text-zinc-400 border-t border-amber-100 dark:border-amber-900/30">
                <Info className="h-3 w-3 shrink-0 mt-px" />
                <span>
                  Volume from {totals.elementsWithVolume.toLocaleString()} of {totals.elementCount.toLocaleString()} elements with reported quantities;
                  multi-material elements are split by layer thickness / constituent fraction.
                </span>
              </div>
            )}
          </div>

          {/* Breakdown by class */}
          {totals.byClass.length > 0 && (
            <div className="border border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-2 px-2.5 py-2 border-b border-zinc-200 dark:border-zinc-800">
                <Boxes className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <span className="font-bold text-xs text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">By Class</span>
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {totals.byClass.map((c) => (
                  <div key={c.ifcClass} className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                    <span className="font-mono text-zinc-600 dark:text-zinc-400 truncate">{c.ifcClass}</span>
                    <span className="font-mono text-zinc-900 dark:text-zinc-100">{c.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Material property sets */}
          {psetCount > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 px-1 pt-1 pb-0.5 text-[11px] text-amber-600/70 dark:text-amber-400/60 uppercase tracking-wider font-semibold">
                <Layers className="h-3 w-3 shrink-0" />
                <span className="truncate">Material Properties</span>
              </div>
              {psetGroups.map((group) =>
                group.psets.map((pset) => {
                  const psetView: PropertySet = {
                    name: pset.name,
                    properties: pset.properties.map((p) => ({ name: p.name, value: p.value, isMutated: false, dataType: p.dataType })),
                  };
                  return <PropertySetCard key={`${group.materialId}-${pset.name}`} pset={psetView} projectUnits={projectUnits} unitDisplayOverrides={unitDisplayOverrides} />;
                }),
              )}
            </div>
          )}

          {psetCount === 0 && totals.elementCount === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-500 text-center py-8 font-mono">
              No data for this material
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** A single label/value row in the material totals card. */
function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-2.5 py-2 text-xs">
      <span className="text-zinc-500 dark:text-zinc-400 font-medium">{label}</span>
      <span className="font-mono font-semibold text-amber-700 dark:text-amber-300 tabular-nums">{value}</span>
    </div>
  );
}
