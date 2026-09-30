/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Completed reports remain reviewable without reattaching historical renderer ids (#6506). */
import { SavedComparisonHistoryNotice } from './SavedComparisonHistoryNotice';
import { analysisStampOf, useAnalysisStaleness } from '@/hooks/useAnalysisStaleness';
import { useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import type { CompareResult } from '@/store/slices/compareSlice';
import { snapshotComparison, comparisonSummary, type SavedComparison } from '@/lib/compare/savedComparisons';
import { reportToCsv } from '@/lib/compare/exportReport';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';

export function SavedComparisonLibrary({ result, running }: { result: CompareResult | null; running: boolean }) {
  const { t } = useTranslation();
  const stale = useAnalysisStaleness(analysisStampOf(result));
  const saved = useViewerStore((s) => s.savedComparisons);
  const models = useViewerStore((s) => s.models);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const save = useViewerStore((s) => s.saveComparison);
  const rename = useViewerStore((s) => s.renameSavedComparison);
  const remove = useViewerStore((s) => s.deleteSavedComparison);
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [renamed, setRenamed] = useState('');
  const selected = saved.find((c) => c.id === selectedId);
  const canSave = !!result && !running && !stale && models.has(result.baseModelId) && models.has(result.headModelId)
    && (result.mutationVersion === undefined || result.mutationVersion === mutationVersion);
  const persisted = (ok: boolean): void => { if (!ok) toast.error(t('comparePanel.saved.storageFailed')); };
  const saveCurrent = (): void => {
    if (!canSave || !result) return;
    const snapshot = snapshotComparison(result, models, name);
    persisted(save(snapshot));
    setSelectedId(snapshot.id);
    setRenamed(snapshot.name);
    setName('');
  };
  const download = (entry: SavedComparison, format: 'csv' | 'json'): void => {
    downloadFile(format === 'csv' ? reportToCsv(entry.report) : JSON.stringify(entry, null, 2),
      `${sanitizeFilename(entry.name, { fallback: 'comparison' })}.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json');
  };
  return (
    <section className="shrink-0 border-b px-3 py-2 text-xs space-y-2" aria-label={t('comparePanel.saved.title')} data-saved-comparisons>
      <div className="font-semibold">{t('comparePanel.saved.title')}</div>
      <SavedComparisonHistoryNotice />
      <div className="flex gap-2">
        <input className="min-w-0 flex-1 rounded border bg-background px-2" value={name} onChange={(e) => setName(e.target.value)}
          aria-label={t('comparePanel.saved.name')} placeholder={result ? `${result.baseName} → ${result.headName}` : t('comparePanel.saved.name')} />
        <Button size="sm" variant="outline" disabled={!canSave} onClick={saveCurrent}>{t('comparePanel.saved.save')}</Button>
      </div>
      <label className="flex items-center gap-2">{t('comparePanel.saved.pick')}
        <select className="min-w-0 flex-1 rounded border bg-background px-2 py-1" value={selected?.id ?? ''} onChange={(e) => {
          setSelectedId(e.target.value); setRenamed(saved.find((c) => c.id === e.target.value)?.name ?? '');
        }}>
          <option value="">{t('comparePanel.saved.placeholder', { count: saved.length })}</option>
          {saved.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.report.baseModel} → {c.report.headModel}</option>)}
        </select>
      </label>
      {selected && <>
        <div className="space-y-1" data-saved-comparison-summary>{comparisonSummary(selected).map((line, i) => <p key={i}>{line}</p>)}</div>
        <div className="flex flex-wrap gap-2">
          <input className="min-w-0 flex-1 rounded border bg-background px-2" value={renamed} onChange={(e) => setRenamed(e.target.value)} aria-label={t('comparePanel.saved.renameName')} />
          <Button size="sm" variant="outline" disabled={!renamed.trim()} onClick={() => persisted(rename(selected.id, renamed))}>{t('comparePanel.saved.rename')}</Button>
          <Button size="sm" variant="outline" onClick={() => download(selected, 'csv')}>CSV</Button>
          <Button size="sm" variant="outline" onClick={() => download(selected, 'json')}>JSON</Button>
          <Button size="sm" variant="outline" onClick={() => { persisted(remove(selected.id)); setSelectedId(''); }}>{t('comparePanel.saved.delete')}</Button>
        </div>
        <p className="text-muted-foreground">{t('comparePanel.saved.hint', { count: selected.report.rows.length })}</p>
        <div className="max-h-48 overflow-auto">
          <table className="w-full text-left"><thead><tr><th>{t('document.table.column.globalId')}</th><th>{t('document.table.column.name')}</th><th>IfcType</th><th>{t('comparePanel.saved.change')}</th></tr></thead>
            <tbody>{selected.report.rows.slice(0, 100).map((row, i) => <tr key={i}><td>{row.globalId}</td><td>{row.name}</td><td>{row.ifcType}</td><td>{row.change}</td></tr>)}</tbody>
          </table>
        </div>
      </>}
    </section>
  );
}
