/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Document panel (#4594): a page over the model. Blocks on the left —
 * text with `{bindings}`, a logo, a chart from a dashboard, a BCF topic —
 * and the page on the right, resolved live. "Export PDF" prints it through
 * the report's jsPDF path; the document itself is a template saved as
 * `.ifclite-document.json` and re-opened on the next model revision.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import type { ReportPageSetup } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { useTranslation } from '@/i18n';
import { localeCount } from '@/i18n/intlFormat';
import { trackExportCompleted } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { blankDocument, DOCUMENT_PRESETS } from '@/lib/document/presets';
import { freshBlockId, freshListCopyId } from '@/lib/document/persistence';
import { LIST_PRESETS } from '@/lib/lists';
import { newChartSpec } from '@/lib/charts/presets';
import { largestBucketIds } from '@/lib/charts/buckets';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import { listCopyForDocument, TABLE_ROWS_DEFAULT, type DocumentBlock, type DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf, type DocumentPdfSeams } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { createSnapshotCapture } from '@/lib/export/report/snapshots';
import { BlockEditor } from './BlockEditor';
import { DocumentMenu } from './DocumentMenu';
import { DocumentPreview } from './DocumentPreview';
import { useDocumentData } from './useDocumentData';

export interface DocumentPanelProps {
  /** Test seam: the PDF seams to print with instead of the browser's. */
  pdfSeams?: () => Promise<DocumentPdfSeams>;
}

/** Seeds a blank document when there is none and makes sure one is active; idempotent (StrictMode runs it twice). */
export function ensureActiveDocument(): void {
  const live = useViewerStore.getState();
  if (live.documents.length === 0) {
    const seeded = blankDocument();
    live.upsertDocument(seeded);
    live.setActiveDocumentId(seeded.id);
  } else if (!live.activeDocumentId || !live.documents.some((d) => d.id === live.activeDocumentId)) {
    live.setActiveDocumentId(live.documents[0].id);
  }
}

export function DocumentPanel({ pdfSeams }: DocumentPanelProps) {
  const { t, locale } = useTranslation();
  const documents = useViewerStore((s) => s.documents);
  const activeDocumentId = useViewerStore((s) => s.activeDocumentId);
  const upsertDocument = useViewerStore((s) => s.upsertDocument);
  const deleteDocument = useViewerStore((s) => s.deleteDocument);
  const setActiveDocumentId = useViewerStore((s) => s.setActiveDocumentId);
  const dashboards = useViewerStore((s) => s.dashboards);
  const listDefinitions = useViewerStore((s) => s.listDefinitions);
  const idsValidationReport = useViewerStore((s) => s.idsValidationReport);

  useEffect(() => { ensureActiveDocument(); }, [documents, activeDocumentId]);

  const document = useMemo(() => documents.find((d) => d.id === activeDocumentId) ?? null, [documents, activeDocumentId]);
  const data = useDocumentData(document);
  const charts = useMemo(() => dashboards.flatMap((d) => d.charts.map((chart) => ({ dashboard: d.name, chart }))), [dashboards]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A write the browser refuses (storage blocked or full) keeps the edit in memory; the author must know before reload.
  const persistWarned = useRef(false);
  const warnUnsaved = useCallback((saved: boolean) => {
    if (saved) { persistWarned.current = false; return; }
    if (persistWarned.current) return;
    persistWarned.current = true;
    toast.error(t('document.panel.unsavedWarning'));
  }, [t]);
  const upsert = useCallback((next: DocumentSpec) => warnUnsaved(upsertDocument(next)), [upsertDocument, warnUnsaved]);
  const remove = useCallback((id: string) => warnUnsaved(deleteDocument(id)), [deleteDocument, warnUnsaved]);
  const update = upsert;
  const setBlocks = useCallback((blocks: DocumentBlock[]) => { if (document) update({ ...document, blocks }); }, [document, update]);

  const addBlock = (kind: DocumentBlock['kind']): void => {
    if (!document) return;
    const id = freshBlockId();
    // A table starts as a copy of the first saved list, else the first preset (#5142). The copy cannot
    // keep a selection snapshot (see `ListTableSource.list`); say so when one is dropped.
    const seedList = listDefinitions[0] ?? LIST_PRESETS[0];
    if (kind === 'table' && seedList.expressIdsByModel) toast.info(t('document.block.tableSelectionDropped'));
    const block: DocumentBlock = kind === 'text' ? { kind, id, text: '', style: 'body' }
      : kind === 'table' ? { kind, id, source: { kind: 'list', list: listCopyForDocument(seedList, freshListCopyId()), fromListId: seedList.id }, maxRows: TABLE_ROWS_DEFAULT }
      : kind === 'image' ? { kind, id, dataUrl: '', height: 60, align: 'left' }
        : kind === 'chart' ? { kind, id, chart: charts[0]?.chart ? { ...charts[0].chart, id: freshBlockId() } : newChartSpec(), snapshot: false }
          : kind === 'spacer' ? { kind, id, height: 20 }
            : kind === 'ids-report' ? (idsValidationReport ? idsReportBlockFromReport(idsValidationReport, id) : { kind, id, sourceName: '', generatedAt: new Date().toISOString(), summary: { checked: 0, passed: 0, failed: 0, passRate: 100 }, checks: [] })
              : { kind, id, guid: [...data.topics.keys()][0] ?? '', snapshot: true };
    setBlocks([...document.blocks, block]);
    setSelectedBlockId(id);
  };

  const exportPdf = useCallback(async () => {
    if (!document) return;
    setBusy(true);
    const snapshot = pdfSeams ? null : createSnapshotCapture();
    try {
      const seams = await (pdfSeams ? pdfSeams() : browserReportSeams(snapshot?.capture ?? null).then((s) => ({ ...s, imageSize: browserImageSize })));
      const result = await generateDocumentPdf({
        document,
        bindings: data.bindings,
        aggregations: data.aggregations,
        chartMessages: data.chartMessages,
        snapshotIds: (blockId) => largestBucketIds(data.aggregations.get(blockId)),
        topics: data.topics,
        tables: data.tables,
      }, seams);
      downloadBlob(result.blob, `${sanitizeFilename(document.name, { fallback: 'document' })}.pdf`);
      // Counts only — never the document's text or name.
      trackExportCompleted({ format: 'pdf', surface: 'document', page_count: result.pages, block_count: document.blocks.length, unresolved_count: result.unresolved.length, table_block_count: document.blocks.filter((b) => b.kind === 'table').length });
      const problems = [
        result.unresolved.length > 0 ? t('document.panel.problemUnresolved', localeCount(locale, result.unresolved.length)) : '',
        result.missingTopics.length > 0 ? t('document.panel.problemMissingTopics', localeCount(locale, result.missingTopics.length)) : '',
        result.snapshotFailures.length > 0 ? t('document.panel.problemSnapshotFailures', localeCount(locale, result.snapshotFailures.length)) : '',
        result.imageFailures.length > 0 ? t('document.panel.problemImageFailures', localeCount(locale, result.imageFailures.length)) : '',
        result.tableFailures.length > 0 ? t('document.panel.problemTables', localeCount(locale, result.tableFailures.length)) : '',
      ].filter(Boolean);
      const pages = localeCount(locale, result.pages);
      toast.success(problems.length > 0
        ? t('document.panel.exportSuccessWithProblems', { ...pages, problems: problems.join(', ') })
        : t('document.panel.exportSuccess', pages));
    } catch (err) {
      console.error('[Documents] export failed', err);
      toast.error(err instanceof Error ? t('document.panel.exportFailedWithMessage', { message: err.message }) : t('document.panel.exportFailedGeneric'));
    } finally {
      snapshot?.restore();
      setBusy(false);
    }
  }, [document, data, pdfSeams, t, locale]);

  // A table whose list is still running would print "not ready"; the export waits for it instead.
  const tablesResolving = useMemo(() => [...data.tables.values()].some((s) => s.status === 'resolving'), [data.tables]);

  const select = 'min-w-0 rounded border border-border bg-transparent px-1.5 py-0.5';

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-document-panel>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <select
          className={select}
          value={activeDocumentId ?? ''}
          onChange={(e) => {
            const preset = DOCUMENT_PRESETS.find((p) => `preset:${p.name}` === e.target.value);
            if (preset) {
              const created = preset.create();
              upsert(created);
              setActiveDocumentId(created.id);
            } else {
              setActiveDocumentId(e.target.value);
            }
          }}
          aria-label={t('document.panel.selectAriaLabel')}
        >
          {documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <optgroup label="New from preset">
            {DOCUMENT_PRESETS.map((p) => <option key={p.name} value={`preset:${p.name}`}>{p.name}</option>)}
          </optgroup>
        </select>
        <DocumentMenu document={document} onUpsert={upsert} onDelete={remove} onActivate={setActiveDocumentId} />
        <label className="inline-flex items-center gap-1 text-muted-foreground">{t('document.panel.pageLabel')}
          <select className={select} value={document?.page.size ?? 'A4'} disabled={!document} onChange={(e) => document && update({ ...document, page: { ...document.page, size: e.target.value as ReportPageSetup['size'] } })} aria-label={t('document.panel.pageSizeAriaLabel')}>
            <option value="A4">{t('document.panel.pageSizeA4')}</option><option value="A3">{t('document.panel.pageSizeA3')}</option>
          </select>
          <select className={select} value={document?.page.orientation ?? 'portrait'} disabled={!document} onChange={(e) => document && update({ ...document, page: { ...document.page, orientation: e.target.value as ReportPageSetup['orientation'] } })} aria-label={t('document.panel.orientationAriaLabel')}>
            <option value="portrait">{t('document.panel.orientationPortrait')}</option><option value="landscape">{t('document.panel.orientationLandscape')}</option>
          </select>
        </label>
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!document} title={t('document.addBlock.buttonTitle')}>
              <Plus className="mr-1 h-3.5 w-3.5" />{t('document.addBlock.button')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 text-xs">
            <DropdownMenuItem onSelect={() => addBlock('text')}>{t('document.addBlock.text')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('image')}>{t('document.addBlock.image')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('chart')}>{t('document.addBlock.chart')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('topic')} disabled={data.topics.size === 0} title={data.topics.size === 0 ? t('document.addBlock.topicDisabledTitle') : undefined}>{t('document.addBlock.topic')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('spacer')}>{t('document.addBlock.spacer')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('table')}>{t('document.addBlock.table')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('ids-report')} disabled={!idsValidationReport} title={idsValidationReport ? undefined : t('document.addBlock.idsReportDisabledTitle')}>{t('document.addBlock.idsReport')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy || tablesResolving || !document || document.blocks.length === 0} aria-busy={tablesResolving || undefined} onClick={() => void exportPdf()} title={t('document.panel.exportTitle')} data-document-export>
          <FileText className="mr-1 h-3.5 w-3.5" />{busy ? t('document.panel.exportBusy') : tablesResolving ? t('document.panel.exportPreparingTables') : t('document.panel.exportIdle')}
        </Button>
      </div>

      {document && (
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[420px] shrink-0 flex-col gap-2 overflow-y-auto overflow-x-hidden border-r border-border p-2" data-document-blocks>
            {document.blocks.map((block, index) => (
              <div key={block.id} className={selectedBlockId === block.id ? 'rounded-md ring-1 ring-sky-500' : undefined} onFocusCapture={() => setSelectedBlockId(block.id)}>
                <BlockEditor
                  block={block}
                  index={index}
                  count={document.blocks.length}
                  bindings={data.bindings}
                  topics={data.topics}
                  charts={charts}
                  idsValidationReport={idsValidationReport}
                  onChange={(next) => setBlocks(document.blocks.map((b) => (b.id === block.id ? next : b)))}
                  onMove={(delta) => {
                    const target = index + delta;
                    if (target < 0 || target >= document.blocks.length) return;
                    const blocks = [...document.blocks];
                    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
                    setBlocks(blocks);
                  }}
                  onRemove={() => setBlocks(document.blocks.filter((b) => b.id !== block.id))}
                />
              </div>
            ))}
            {document.blocks.length === 0 && <div className="p-2 text-muted-foreground">{t('document.panel.emptyBlocks')}</div>}
          </div>
          <div className="min-w-0 flex-1 overflow-auto bg-muted/40">
            <DocumentPreview document={document} bindings={data.bindings} aggregations={data.aggregations} chartMessages={data.chartMessages} topics={data.topics} tables={data.tables} selectedBlockId={selectedBlockId} onSelectBlock={setSelectedBlockId} />
          </div>
        </div>
      )}
    </div>
  );
}
