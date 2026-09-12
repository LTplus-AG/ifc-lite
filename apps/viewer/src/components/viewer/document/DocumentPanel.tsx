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
import { FileText, Plus, X } from 'lucide-react';
import type { ReportPageSetup } from '@ifc-lite/charts';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';
import { blankDocument, DOCUMENT_PRESETS } from '@/lib/document/presets';
import { freshBlockId } from '@/lib/document/persistence';
import { newChartSpec } from '@/lib/charts/presets';
import { largestBucketIds } from '@/lib/charts/buckets';
import type { DocumentBlock, DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf, type DocumentPdfSeams } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { createSnapshotCapture } from '@/lib/export/report/snapshots';
import { BlockEditor } from './BlockEditor';
import { DocumentMenu } from './DocumentMenu';
import { DocumentPreview } from './DocumentPreview';
import { useDocumentData } from './useDocumentData';

export interface DocumentPanelProps {
  onClose?: () => void;
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

export function DocumentPanel({ onClose, pdfSeams }: DocumentPanelProps) {
  const documents = useViewerStore((s) => s.documents);
  const activeDocumentId = useViewerStore((s) => s.activeDocumentId);
  const upsertDocument = useViewerStore((s) => s.upsertDocument);
  const deleteDocument = useViewerStore((s) => s.deleteDocument);
  const setActiveDocumentId = useViewerStore((s) => s.setActiveDocumentId);
  const dashboards = useViewerStore((s) => s.dashboards);

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
    toast.error('The document could not be saved in this browser (storage blocked or full). Export it as a template before you reload.');
  }, []);
  const upsert = useCallback((next: DocumentSpec) => warnUnsaved(upsertDocument(next)), [upsertDocument, warnUnsaved]);
  const remove = useCallback((id: string) => warnUnsaved(deleteDocument(id)), [deleteDocument, warnUnsaved]);
  const update = upsert;
  const setBlocks = useCallback((blocks: DocumentBlock[]) => { if (document) update({ ...document, blocks }); }, [document, update]);

  const addBlock = (kind: DocumentBlock['kind']): void => {
    if (!document) return;
    const id = freshBlockId();
    const block: DocumentBlock = kind === 'text' ? { kind, id, text: '', style: 'body' }
      : kind === 'image' ? { kind, id, dataUrl: '', height: 60, align: 'left' }
        : kind === 'chart' ? { kind, id, chart: charts[0]?.chart ? { ...charts[0].chart, id: freshBlockId() } : newChartSpec(), snapshot: false }
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
        snapshotIds: (blockId) => largestBucketIds(data.aggregations.get(blockId)),
        topics: data.topics,
      }, seams);
      downloadBlob(result.blob, `${sanitizeFilename(document.name, { fallback: 'document' })}.pdf`);
      // Counts only — never the document's text or name.
      posthog.capture('export_completed', { format: 'pdf', surface: 'document', page_count: result.pages, block_count: document.blocks.length, unresolved_count: result.unresolved.length });
      const problems = [
        result.unresolved.length > 0 ? `${result.unresolved.length} binding${result.unresolved.length === 1 ? '' : 's'} unresolved` : '',
        result.missingTopics.length > 0 ? `${result.missingTopics.length} topic${result.missingTopics.length === 1 ? '' : 's'} not loaded` : '',
        result.snapshotFailures.length > 0 ? `${result.snapshotFailures.length} snapshot${result.snapshotFailures.length === 1 ? '' : 's'} unavailable` : '',
        result.imageFailures.length > 0 ? `${result.imageFailures.length} image${result.imageFailures.length === 1 ? '' : 's'} unavailable` : '',
      ].filter(Boolean);
      toast.success(`Document exported: ${result.pages} page${result.pages === 1 ? '' : 's'}${problems.length > 0 ? ` (${problems.join(', ')})` : ''}`);
    } catch (err) {
      console.error('[Documents] export failed', err);
      toast.error(err instanceof Error ? `Document export failed: ${err.message}` : 'Document export failed');
    } finally {
      snapshot?.restore();
      setBusy(false);
    }
  }, [document, data, pdfSeams]);

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
          aria-label="Document"
        >
          {documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <optgroup label="New from preset">
            {DOCUMENT_PRESETS.map((p) => <option key={p.name} value={`preset:${p.name}`}>{p.name}</option>)}
          </optgroup>
        </select>
        <DocumentMenu document={document} onUpsert={upsert} onDelete={remove} onActivate={setActiveDocumentId} />
        <label className="inline-flex items-center gap-1 text-muted-foreground">Page
          <select className={select} value={document?.page.size ?? 'A4'} disabled={!document} onChange={(e) => document && update({ ...document, page: { ...document.page, size: e.target.value as ReportPageSetup['size'] } })} aria-label="Page size">
            <option value="A4">A4</option><option value="A3">A3</option>
          </select>
          <select className={select} value={document?.page.orientation ?? 'portrait'} disabled={!document} onChange={(e) => document && update({ ...document, page: { ...document.page, orientation: e.target.value as ReportPageSetup['orientation'] } })} aria-label="Orientation">
            <option value="portrait">Portrait</option><option value="landscape">Landscape</option>
          </select>
        </label>
        <span className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={!document} title="Add a block to the page">
              <Plus className="mr-1 h-3.5 w-3.5" />Add block
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44 text-xs">
            <DropdownMenuItem onSelect={() => addBlock('text')}>Text with fields</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('image')}>Image / logo</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('chart')}>Chart</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => addBlock('topic')} disabled={data.topics.size === 0} title={data.topics.size === 0 ? 'No BCF topics loaded' : undefined}>BCF topic</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={busy || !document || document.blocks.length === 0} onClick={() => void exportPdf()} title="Print this page to a PDF" data-document-export>
          <FileText className="mr-1 h-3.5 w-3.5" />{busy ? 'Exporting…' : 'Export PDF'}
        </Button>
        {onClose && (
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose} aria-label="Close document panel">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
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
            {document.blocks.length === 0 && <div className="p-2 text-muted-foreground">No blocks yet — "Add block" above.</div>}
          </div>
          <div className="min-w-0 flex-1 overflow-auto bg-muted/40">
            <DocumentPreview document={document} bindings={data.bindings} aggregations={data.aggregations} topics={data.topics} selectedBlockId={selectedBlockId} onSelectBlock={setSelectedBlockId} />
          </div>
        </div>
      )}
    </div>
  );
}
