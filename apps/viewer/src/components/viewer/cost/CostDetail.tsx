/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CostDetail — the Cost panel's read-only detail view for one selected
 * `IfcCostItem` (#4858): resolved value + currency, quantities, owning
 * schedule(s), diagnostics, and assigned products/tasks with a 3D-select
 * action. No editing affordance anywhere — spreadsheet-style cost editing
 * is explicitly out of scope for this issue.
 *
 * "Unresolved" is never inferred from an absent field: it is exactly
 * `evaluation.Amount === undefined` (`isUnresolved`, `lib/cost/cost-tree`),
 * with the evaluator's own diagnostics shown to explain why.
 */

import { AlertTriangle, Crosshair } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/useTranslation';
import type { CostBackendMethods, CostGraphData } from '@ifc-lite/sdk';
import {
  getAssignedTargets,
  getOwningSchedules,
  isUnresolved,
  type EntityRefLike,
} from '@/lib/cost/cost-tree';

export interface CostDetailProps {
  graph: CostGraphData;
  itemRef: EntityRefLike;
  backend: CostBackendMethods;
  onSelectTargets: (refs: EntityRefLike[]) => void;
}

function DiagnosticList({ diagnostics }: { diagnostics: CostGraphData['Diagnostics'] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {diagnostics.map((d, i) => (
        // Diagnostics have no stable id of their own; index is fine — this
        // list is re-derived fresh from the evaluation on every render, never reordered in place.
        <li key={i} className="flex items-start gap-1 text-[10px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-2.5 w-2.5 shrink-0" />
          <span>{d.Message}</span>
        </li>
      ))}
    </ul>
  );
}

export function CostDetail({ graph, itemRef, backend, onSelectTargets }: CostDetailProps) {
  const { t } = useTranslation();
  const item = useMemo(
    () => graph.CostItems.find((i) => i.ref.expressId === itemRef.expressId),
    [graph, itemRef],
  );
  // `graph` is not read by the callback, but a refreshed graph means the
  // backend's underlying store changed, so the evaluation must recompute.
  const evaluation = useMemo(() => backend.evaluateItem(itemRef), [backend, itemRef, graph]);
  const quantities = useMemo(() => {
    const qIds = new Set(item?.CostQuantities?.map((r) => r.expressId) ?? []);
    return graph.CostQuantities.filter((q) => qIds.has(q.ref.expressId));
  }, [graph, item]);
  const owningSchedules = useMemo(() => getOwningSchedules(graph, itemRef), [graph, itemRef]);
  const targets = useMemo(() => getAssignedTargets(graph, itemRef), [graph, itemRef]);

  if (!item) {
    return <div className="p-3 text-xs text-muted-foreground">{t('costPanel.itemUnavailable')}</div>;
  }

  const unresolved = isUnresolved(evaluation);

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3 text-xs">
      <div className="mb-2">
        <div className="text-sm font-semibold">{item.Name ?? t('costPanel.itemFallbackName', { id: item.ref.expressId })}</div>
        {item.Description && <div className="text-muted-foreground">{item.Description}</div>}
        <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {item.Identification && <span>{t('costPanel.identification', { value: item.Identification })}</span>}
          {item.PredefinedType && <span>{item.PredefinedType}</span>}
          {item.GlobalId && <span className="truncate">{item.GlobalId}</span>}
        </div>
      </div>

      <div className="mb-3 rounded border p-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('costPanel.resolvedValue')}</div>
        {unresolved ? (
          <div className="mt-1 flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{t('costPanel.unresolvedValue')}</span>
          </div>
        ) : (
          <div className="mt-1 text-sm font-medium">
            {evaluation.Amount}
            {evaluation.Currency ? ` ${evaluation.Currency}` : ''}
          </div>
        )}
        <DiagnosticList diagnostics={evaluation.Diagnostics} />
      </div>

      {owningSchedules.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('costPanel.schedule')}</div>
          {owningSchedules.map((s) => (
            <div key={s.ref.expressId} className="mt-0.5">{s.Name ?? t('costPanel.scheduleFallbackName', { id: s.ref.expressId })}</div>
          ))}
        </div>
      )}

      {quantities.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('costPanel.quantities')}</div>
          {quantities.map((q) => {
            const value = q.LengthValue ?? q.AreaValue ?? q.VolumeValue ?? q.WeightValue ?? q.CountValue ?? q.TimeValue ?? q.NumberValue;
            return (
              <div key={q.ref.expressId} className="mt-0.5 flex justify-between gap-2">
                <span className="truncate text-muted-foreground">{q.Name ?? q.Type}</span>
                <span>{value ?? '—'}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('costPanel.assignedTargets')}
          </span>
          {targets.length > 0 && (
            <Button variant="ghost" size="sm" className="h-5 gap-1 px-1.5 text-[10px]" onClick={() => onSelectTargets(targets)}>
              <Crosshair className="h-2.5 w-2.5" /> {t('costPanel.selectInViewport')}
            </Button>
          )}
        </div>
        {targets.length === 0 ? (
          <div className="text-muted-foreground">{t('costPanel.noAssignedTargets')}</div>
        ) : (
          targets.map((t) => (
            <button
              type="button"
              key={`${t.modelId}:${t.expressId}`}
              className="mt-0.5 block w-full truncate rounded px-1 py-0.5 text-left hover:bg-accent"
              onClick={() => onSelectTargets([t])}
            >
              #{t.expressId}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
