/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Retained geometry panel (#7955 M2, spec §2.2), opened from the viewport
 * chip. Lists every candidate product that has no retained geometry — refused
 * by the kernel, or never reached — with its code, origin and a plain-language
 * message. Those products are absent from the viewport; nothing substitutes
 * exact geometry for them. The only way to exact geometry is the explicit,
 * whole-model "Reload with exact kernel".
 */

import { useMemo, useState } from 'react';
import { ArrowUpDown, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { registerEnglish, useTranslation, type TranslationKey } from '@/i18n';
import { retainedGeometryEn } from '@/i18n/catalogues/retained-geometry.en';
import { toGlobalIdFromModels, useViewerStore } from '@/store';
import { chooseGeometryKernel } from '@/store/geometryKernel';
import type { RetainedGeometrySummary, RetainedUnpublishedRow } from '@/store/retainedGeometry';
import { RetainedEngineDetails } from './RetainedEngineDetails';
import { RetainedFaceTable } from './RetainedFaceTable';

registerEnglish(retainedGeometryEn);

type SortKey = 'expressId' | 'ifcType' | 'code';
const KNOWN_CODES = new Set([
  'opening_strategy', 'material_layer_strategy', 'operation_unsupported', 'source_invalid', 'source_changed',
  'incomplete', 'empty_result', 'family_unqualified', 'kernel_failure', 'worker_fault', 'worker_retired',
  'resource_exhausted', 'deadline_exceeded', 'cancelled', 'contract_breach',
  'opening_unsupported', 'appearance_unsupported', 'face_provenance_unproven',
]);

export interface RetainedGeometryPanelProps {
  modelId: string;
  summary: RetainedGeometrySummary;
  /** The file to reload; absent once the source is no longer held. */
  sourceFile?: File;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Loads `file` as the primary model; called after the kernel switched to exact. */
  reload: (file: File) => unknown;
}

export function useObligationList(obligations: readonly string[]): string {
  const { t } = useTranslation();
  return obligations.map((name) => t(`retainedGeometry.obligation.${name}` as TranslationKey)).join(', ');
}

export function RetainedGeometryPanel({ modelId, summary, sourceFile, open, onOpenChange, reload }: RetainedGeometryPanelProps) {
  const { t } = useTranslation();
  const [code, setCode] = useState<string>('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'expressId', descending: false });
  const notApplied = useObligationList(summary.obligationsUnmet);
  const refused = summary.refused.length - summary.cancelled;

  const codes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of summary.refused) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [summary.refused]);
  const rows = useMemo(() => {
    const visible = code ? summary.refused.filter((row) => row.code === code) : [...summary.refused];
    const direction = sort.descending ? -1 : 1;
    return visible.sort((a, b) => direction * (sort.key === 'expressId'
      ? a.expressId - b.expressId
      : a[sort.key].localeCompare(b[sort.key]) || a.expressId - b.expressId));
  }, [summary.refused, code, sort]);

  const select = (row: RetainedUnpublishedRow) => {
    // Two-channel selection (AGENTS.md): the global id drives 3D highlight,
    // the {modelId, expressId} ref drives the properties panel.
    const state = useViewerStore.getState();
    state.setSelectedEntityIds([]);
    state.setSelectedEntityId(toGlobalIdFromModels(state.models, modelId, row.expressId));
    state.setSelectedEntity({ modelId, expressId: row.expressId });
  };
  const reloadExact = () => {
    if (!sourceFile) return;
    chooseGeometryKernel('exact');
    onOpenChange(false);
    void reload(sourceFile);
  };
  const sortBy = (key: SortKey) => setSort((prev) => ({ key, descending: prev.key === key && !prev.descending }));
  const header = (key: SortKey | null, label: TranslationKey) => (
    <th scope="col" className="px-2 py-1 text-left font-medium" aria-sort={key && sort.key === key ? (sort.descending ? 'descending' : 'ascending') : undefined}>
      {key ? (
        <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(key)}
          aria-label={t('retainedGeometry.panel.sortBy', { column: t(label) })}>
          {t(label)}<ArrowUpDown aria-hidden className="h-3 w-3" />
        </button>
      ) : t(label)}
    </th>
  );
  const message = (row: RetainedUnpublishedRow) => KNOWN_CODES.has(row.code)
    ? t(`retainedGeometry.code.${row.code}` as TranslationKey)
    : t('retainedGeometry.code.other', { code: row.code });
  const origin = (row: RetainedUnpublishedRow) => !row.origin ? '' : row.origin.entity !== undefined
    ? t('retainedGeometry.panel.originEntity', { cause: row.origin.cause, site: row.origin.site, entity: String(row.origin.entity) })
    : t('retainedGeometry.panel.origin', { cause: row.origin.cause, site: row.origin.site });
  const state = summary.failure
    ? t('retainedGeometry.panel.state.failure', { reason: summary.failure })
    : summary.completeness === 'running' ? t('retainedGeometry.panel.state.running')
      : summary.completeness === 'complete' ? t('retainedGeometry.panel.state.complete')
        : t('retainedGeometry.panel.state.incomplete', { count: String(summary.refused.length), candidates: String(summary.candidates) });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-retained-geometry-panel="">
        <DialogHeader>
          <DialogTitle>{t('retainedGeometry.panel.title')}</DialogTitle>
          <DialogDescription>{t('retainedGeometry.panel.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1 text-sm">
          <p data-retained-state={summary.failure ? 'stopped' : summary.completeness}>{state}</p>
          <p className="text-muted-foreground">{t('retainedGeometry.panel.counts', {
            published: String(summary.published), candidates: String(summary.candidates),
            refused: String(refused), cancelled: String(summary.cancelled),
          })}</p>
          {notApplied && <p className="text-muted-foreground">{t('retainedGeometry.panel.notApplied', { obligations: notApplied })}</p>}
        </div>
        <RetainedFaceTable modelId={modelId} faces={summary.faces} />
        {summary.refused.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('retainedGeometry.panel.none')}</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              {t('retainedGeometry.panel.filterLabel')}
              <select className="rounded border bg-transparent px-1.5 py-0.5 text-sm" value={code} onChange={(event) => setCode(event.target.value)}>
                <option value="">{t('retainedGeometry.panel.filterAll', { count: String(summary.refused.length) })}</option>
                {codes.map(([value, count]) => (
                  <option key={value} value={value}>{t('retainedGeometry.panel.filterCode', { code: value, count: String(count) })}</option>
                ))}
              </select>
            </label>
            <div className="max-h-80 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background text-muted-foreground">
                  <tr>
                    {header('expressId', 'retainedGeometry.panel.column.id')}
                    {header('ifcType', 'retainedGeometry.panel.column.ifcType')}
                    {header('code', 'retainedGeometry.panel.column.code')}
                    {header(null, 'retainedGeometry.panel.column.origin')}
                    {header(null, 'retainedGeometry.panel.column.message')}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={5} className="px-2 py-2 text-muted-foreground">{t('retainedGeometry.panel.noMatches')}</td></tr>
                  )}
                  {rows.map((row) => (
                    <tr key={row.expressId} data-retained-row={row.expressId} data-code={row.code}
                      className="cursor-pointer border-t hover:bg-muted/50" onClick={() => select(row)}>
                      <td className="px-2 py-1 tabular-nums">
                        <button type="button" className="hover:underline" aria-label={t('retainedGeometry.panel.selectRow', { id: String(row.expressId) })}
                          onClick={(event) => { event.stopPropagation(); select(row); }}>
                          {t('retainedGeometry.panel.rowId', { id: String(row.expressId) })}
                        </button>
                      </td>
                      <td className="px-2 py-1">{row.ifcType || t('retainedGeometry.panel.unknownType')}</td>
                      <td className="px-2 py-1 font-mono">{row.code}</td>
                      <td className="px-2 py-1">{origin(row)}</td>
                      <td className="px-2 py-1">{message(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <RetainedEngineDetails />
          <div className="grid justify-items-end gap-1">
            <Button type="button" onClick={reloadExact} disabled={!sourceFile}>
              <RefreshCw aria-hidden className="mr-1.5 h-4 w-4" />{t('retainedGeometry.panel.reloadExact')}
            </Button>
            {!sourceFile && <p className="text-xs text-muted-foreground">{t('retainedGeometry.panel.reloadUnavailable')}</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
