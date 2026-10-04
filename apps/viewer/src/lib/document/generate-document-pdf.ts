/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Print a document (#4594): bindings resolved, blocks measured, pages
 * composed (`compose.ts`), then drawn through the report's PDF seams —
 * the same jsPDF + svg2pdf + snapshot path the coordination report uses,
 * so a chart block prints exactly as it does in a report.
 */
import { blockTitle, blockHeaderStyleFields } from './block-title.js';
import { isSavedComparisonChart } from '../charts/comparison-source.js';
import { drawChartSourceMessage } from '../export/report/render-source-message.js';
import { tableHeaderStyle } from '../table-header-style';
import { comparisonSummary } from '../compare/savedComparisonSchema';
import type { Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import type { ReportDoc, ReportPdfSeams } from '../export/report/generate-report-pdf.js';
import { dataUrlToBytes } from '../export/download.js';
import { localIsoDate, renderTemplate, type BindingContext } from './bindings.js';
import type { DocumentLayout, ResolvedBlock } from './compose.js';
import { composeResolvedDocument, documentTextMeasure, pageBandImageAspects } from './document-layout.js';
import { flattenExportModel, flattenRawModel, type TableState } from './resolve-table.js';
import { TABLE_ROWS_DEFAULT, type DocumentSpec } from './types.js';
import { ringSvg } from '../validation/manual/ring.js';
import type { DocumentLabelFormatter } from './document-labels.js';
import { documentTableColumns, documentTableLabels, tableMessage, tableTitle } from './document-table-labels.js';
export { TABLE_PDF_LABELS, tableMessage, tableTitle } from './document-table-labels.js';

export interface DocumentPdfSeams extends ReportPdfSeams {
  /** Natural size of an image (data URL); the layout keeps its aspect ratio. */
  imageSize: (dataUrl: string) => Promise<{ w: number; h: number }>;
}

export interface DocumentPdfInput {
  document: DocumentSpec;
  /** Captured UI label context; absent preserves English for existing/headless callers. */
  labels?: DocumentLabelFormatter;
  bindings: BindingContext;
  /** Chart block id → its aggregation over the loaded model (`null`: cannot aggregate). */
  aggregations: Map<string, Aggregation | null>;
  /** Chart block id → source provenance or a resolving/refused error caption.
   * Errors print instead of generic "No data"; chartErrors distinguishes
   * them from informative recorded-source captions (#4946 / #6549). */
  chartMessages: Map<string, string>;
  /** IDs whose chartMessages are failures; absent retains legacy message-only diagnostics.
   * Recorded-source provenance is informative and is not included in this set (#6549). */
  chartErrors?: ReadonlySet<string>;
  /** Ids of the elements of a chart block's largest bucket, for the snapshot. */
  snapshotIds: (blockId: string) => readonly number[];
  /** BCF topics by GUID. */
  topics: Map<string, BCFTopic>;
  /** Table block id → its list run (#5142); a block with no entry prints as still resolving. */
  tables: ReadonlyMap<string, TableState>;
}

export interface DocumentPdfResult {
  blob: Blob;
  pages: number;
  /** Binding paths that did not resolve; they print as `[path: reason]`. */
  unresolved: string[];
  /** Topic blocks whose GUID is not among the loaded topics. */
  missingTopics: string[];
  snapshotFailures: string[];
  /** Images jsPDF could not decode; the page says so in their place. */
  imageFailures: string[];
  /** Table blocks whose list did not run (no model, still resolving, or an error); the page says so in their place. */
  tableFailures: string[];
  /** Missing sources, refused filters and aggregation errors printed in the chart's place. */
  chartFailures?: string[];
}

/** The browser's image measure: decode the data URL. */
export function browserImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('The image could not be decoded'));
    img.src = dataUrl;
  });
}

export const topicLines = (topic: BCFTopic): string[] => {
  const lines: string[] = [];
  const field = (label: string, value: string | undefined): void => { if (value && value.trim()) lines.push(`${label}: ${value}`); };
  field('Status', topic.topicStatus);
  field('Type', topic.topicType);
  field('Priority', topic.priority);
  field('Assigned to', topic.assignedTo);
  field('Created', topic.creationDate ? `${topic.creationDate.slice(0, 10)}${topic.creationAuthor ? ` by ${topic.creationAuthor}` : ''}` : undefined);
  field('Due', topic.dueDate?.slice(0, 10));
  if (topic.description?.trim()) lines.push(topic.description.trim());
  return lines;
};

/** The first viewpoint snapshot as a data URL, or null. */
export function topicSnapshotDataUrl(topic: BCFTopic): string | null {
  for (const vp of topic.viewpoints ?? []) {
    if (vp.snapshot?.startsWith('data:image/')) return vp.snapshot;
    if (vp.snapshotData && vp.snapshotData.length > 0) {
      let binary = '';
      for (const byte of vp.snapshotData) binary += String.fromCharCode(byte);
      return `data:image/png;base64,${btoa(binary)}`;
    }
  }
  return null;
}

/** Resolve every block against the model — what the composer and the preview share. */
export async function resolveBlocks(input: DocumentPdfInput, imageSize: DocumentPdfSeams['imageSize'], result: Pick<DocumentPdfResult, 'unresolved' | 'missingTopics' | 'tableFailures'>): Promise<ResolvedBlock[]> {
  const blocks: ResolvedBlock[] = [];
  for (const block of input.document.blocks) {
    switch (block.kind) {
      case 'text': {
        const rendered = renderTemplate(block.text, input.bindings);
        for (const b of rendered.bindings) if (!b.ok) result.unresolved.push(b.path);
        blocks.push({ ...block, text: rendered.text, bindingSpans: rendered.spans });
        break;
      }
      case 'image': {
        let aspect = 1;
        try {
          const size = await imageSize(block.dataUrl);
          if (size.w > 0 && size.h > 0) aspect = size.w / size.h;
        } catch (err) {
          console.warn('[Documents] image could not be measured; printed square', err);
        }
        blocks.push({ kind: 'image', id: block.id, height: block.height, align: block.align, caption: block.caption, title: block.title, aspect, width: block.width, scale: block.scale, ...blockHeaderStyleFields(block) });
        break;
      }
      case 'chart': {
        const agg = input.aggregations.get(block.id) ?? null;
        // A resolving/refused filter (#4946) names itself instead of the
        // generic "No data" — review finding: this used to be computed only
        // from `agg`, so `chartMessages` reached `resolveBlocks` but nothing
        // here ever read it.
        const message = input.chartMessages.get(block.id);
        const hasData = !!agg && agg.categories.length > 0;
        const subtitle = isSavedComparisonChart(block.chart) && !hasData ? '' : message ?? (agg ? `${agg.categories.length} bucket${agg.categories.length === 1 ? '' : 's'} · ${agg.total.toLocaleString()} ${agg.spec.measure.agg === 'count' ? 'elements' : (agg.unit ?? '')}`.trim() : 'No data');
        blocks.push({ kind: 'chart', id: block.id, title: blockTitle(block, block.chart.title), subtitle, hasData, snapshot: block.snapshot && !isSavedComparisonChart(block.chart), height: block.height, width: block.width, fontSize: block.fontSize, scale: block.scale, ...blockHeaderStyleFields(block) });
        break;
      }
      case 'page-break': blocks.push(block); break;
      case 'spacer': {
        blocks.push({ kind: 'spacer', id: block.id, height: block.height });
        break;
      }
      case 'table': {
        const state = input.tables.get(block.id);
        const headerStyle = block.headerBackground || block.headerTextColor
          ? tableHeaderStyle(block.headerBackground, block.headerTextColor) : undefined;
        const message = tableMessage(state, input.labels);
        if (state?.status === 'ok' && message === null) {
          const flat = state.kind === 'validation' || state.kind === 'comparison'
            ? flattenRawModel(state.model, block.maxRows ?? TABLE_ROWS_DEFAULT, documentTableLabels(input.labels))
            : flattenExportModel(state.model, block.maxRows ?? TABLE_ROWS_DEFAULT, documentTableLabels(input.labels), block.groupOrder);
          blocks.push({ kind: 'table', id: block.id, title: tableTitle(block, input.labels), caption: block.caption, headerStyle, scale: block.scale, ...blockHeaderStyleFields(block), summary: block.source.kind === 'comparison' ? comparisonSummary(block.source.comparison) : undefined, columns: documentTableColumns(flat.columns, state.kind === 'validation' ? input.labels : undefined), rows: flat.rows });
          break;
        }
        if (state?.status !== 'ok') result.tableFailures.push(block.id);
        // `tableMessage` is non-null for every non-ok state; the fallback only satisfies the types.
        blocks.push({ kind: 'table', id: block.id, title: tableTitle(block, input.labels), caption: block.caption, headerStyle, scale: block.scale, ...blockHeaderStyleFields(block), summary: block.source.kind === 'comparison' ? comparisonSummary(block.source.comparison) : undefined, message: message ?? 'No rows to print.', columns: [], rows: [] });
        break;
      }
      case 'ids-report': {
        // A frozen snapshot (`ids-report.ts`), not model-derived — nothing to resolve against bindings.
        blocks.push({ ...block, kind: 'ids-report' });
        break;
      }
      case 'manual-report': {
        // Also a frozen snapshot (`manual-report.ts`, #6401).
        blocks.push({ ...block, kind: 'manual-report' });
        break;
      }
      case 'topic': {
        const topic = input.topics.get(block.guid);
        if (!topic) {
          result.missingTopics.push(block.guid);
          blocks.push({ kind: 'topic', id: block.id, authoredTitle: !!blockTitle(block), title: blockTitle(block, `[BCF topic ${block.guid}: not among the loaded topics]`), lines: blockTitle(block) ? [`[BCF topic ${block.guid}: not among the loaded topics]`] : [], snapshotAspect: null, scale: block.scale, ...blockHeaderStyleFields(block) });
          break;
        }
        let snapshotAspect: number | null = null;
        const dataUrl = block.snapshot ? topicSnapshotDataUrl(topic) : null;
        if (dataUrl) {
          try {
            const size = await imageSize(dataUrl);
            snapshotAspect = size.w > 0 && size.h > 0 ? size.w / size.h : 4 / 3;
          } catch (err) {
            console.warn(`[Documents] viewpoint snapshot of "${topic.title}" could not be measured; printed 4:3`, err);
            snapshotAspect = 4 / 3;
          }
        }
        blocks.push({ kind: 'topic', id: block.id, authoredTitle: !!blockTitle(block), title: blockTitle(block, topic.title), lines: topicLines(topic), snapshotAspect, scale: block.scale, ...blockHeaderStyleFields(block) });
        break;
      }
    }
  }
  return blocks;
}

function drawHeaderFooter(doc: ReportDoc, layout: DocumentLayout, pageIndex: number, result: DocumentPdfResult): void {
  for (const item of layout.pageFrames[pageIndex]) {
    if (item.kind === 'image') { placeImage(doc, item.dataUrl, `page ${item.band} logo`, item, result); continue; }
    doc.setFont(item.font, 'normal'); doc.setFontSize(item.size); doc.setTextColor(item.color ?? item.gray);
    doc.text(item.text, item.x, item.y);
  }
  doc.setTextColor(0);
}

const imageFormat = (dataUrl: string): 'PNG' | 'JPEG' => (dataUrl.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG');

/** Place an image; a file jsPDF cannot decode leaves a note in its box instead of aborting the export. */
function placeImage(doc: ReportDoc, dataUrl: string | null, label: string, box: { x: number; y: number; w: number; h: number }, result: DocumentPdfResult): void {
  const bytes = dataUrl ? dataUrlToBytes(dataUrl) : undefined;
  if (bytes && dataUrl) {
    try {
      doc.addImage(bytes, imageFormat(dataUrl), box.x, box.y, box.w, box.h);
      return;
    } catch (err) {
      console.warn(`[Documents] image "${label}" could not be placed`, err);
    }
  }
  result.imageFailures.push(label);
  doc.setFontSize(9);
  doc.setTextColor(130);
  doc.text(`Image unavailable: ${label}`, box.x, box.y + 14);
  doc.setTextColor(0);
}

export async function generateDocumentPdf(input: DocumentPdfInput, seams: DocumentPdfSeams): Promise<DocumentPdfResult> {
  const result: DocumentPdfResult = { blob: new Blob(), pages: 0, unresolved: [], missingTopics: [], snapshotFailures: [], imageFailures: [], tableFailures: [],
    chartFailures: input.document.blocks.flatMap((block) => block.kind === 'chart' && input.chartMessages.has(block.id)
      && (input.chartErrors === undefined || input.chartErrors.has(block.id))
      ? [`${block.chart.title}: ${input.chartMessages.get(block.id)}`] : []),
  };
  const format = input.document.page.size === 'A3' ? 'a3' : 'a4';
  const doc = await seams.createDoc(format, input.document.page.orientation);
  const blocks = await resolveBlocks(input, seams.imageSize, result);

  const logoAspects = await pageBandImageAspects(input.document, seams.imageSize);
  const layout = composeResolvedDocument(input.document, blocks, seams.now().toLocaleString(), documentTextMeasure(doc), input.labels,
    logoAspects, localIsoDate(input.bindings.today));
  const byId = new Map(input.document.blocks.map((b) => [b.id, b]));
  const topicsByBlock = new Map(input.document.blocks.filter((b) => b.kind === 'topic').map((b) => [b.id, input.topics.get((b as { guid: string }).guid)]));

  for (const page of layout.pages) {
    if (page.index > 0) doc.addPage(format, input.document.page.orientation);
    drawHeaderFooter(doc, layout, page.index, result);
    for (const item of page.items) {
      switch (item.kind) {
        case 'text':
          doc.setFont(item.font ?? 'helvetica', item.bold ? 'bold' : 'normal');
          doc.setFontSize(item.size);
          doc.setTextColor(item.color ?? item.gray);
          doc.text(item.text, item.x, item.y);
          doc.setTextColor(0);
          break;
        case 'rect':
        case 'text-background':
          doc.fillRect(item.x, item.y, item.w, item.h, item.color);
          break;
        case 'image': {
          const block = byId.get(item.blockId);
          if (block?.kind === 'image') placeImage(doc, block.dataUrl || null, block.caption || 'logo', item, result);
          break;
        }
        case 'chart': {
          const agg = input.aggregations.get(item.blockId);
          if (agg && agg.categories.length > 0) {
            const block = byId.get(item.blockId);
            // A scaled chart (#6548) is rendered at its authored size and placed `scale` times larger, so its text and plot grow together.
            const scale = item.scale ?? 1;
            await doc.svg(seams.renderSvg(agg, item.w / scale, item.h / scale, seams.theme, block?.kind === 'chart' ? block.fontSize : undefined), item.x, item.y, item.w, item.h);
          } else {
            doc.setFontSize(9);
            doc.setTextColor(130);
            // A resolving/refused filter (#4946) prints its own reason instead
            // of the generic line, same as `resolveBlocks`'s subtitle above.
            const message = input.chartMessages.get(item.blockId) ?? 'No data for this chart.';
            const block = byId.get(item.blockId);
            if (block?.kind === 'chart' && isSavedComparisonChart(block.chart)) drawChartSourceMessage(doc, message, item, 9);
            else doc.text(message, item.x, item.y + 14);
            doc.setTextColor(0);
          }
          break;
        }
        case 'snapshot': {
          let png: Uint8Array | undefined;
          try {
            png = await seams.capture?.(input.snapshotIds(item.blockId));
          } catch (err) {
            console.warn('[Documents] snapshot failed', err);
          }
          if (png) {
            try {
              doc.addImage(png, 'PNG', item.x, item.y, item.w, item.h);
            } catch (err) {
              console.warn('[Documents] snapshot could not be placed', err);
              png = undefined;
            }
          }
          if (!png) {
            const block = byId.get(item.blockId);
            result.snapshotFailures.push(block?.kind === 'chart' ? block.chart.title : item.blockId);
            doc.setFontSize(9);
            doc.setTextColor(130);
            doc.text('3D snapshot unavailable.', item.x, item.y + 14);
            doc.setTextColor(0);
          }
          break;
        }
        case 'ring':
          // Colour lives only in the ring; its counts are printed beside it in words (#6401).
          await doc.svg(ringSvg(item.counts, item.size), item.x, item.y, item.size, item.size);
          break;
        case 'topic-snapshot': {
          const topic = topicsByBlock.get(item.blockId);
          placeImage(doc, topic ? topicSnapshotDataUrl(topic) : null, topic ? `viewpoint of "${topic.title}"` : 'viewpoint', item, result);
          break;
        }
        case 'table':
          // One chunk per call; the composer cut it to fit, so autotable never breaks the page itself.
          doc.table({
            startY: item.y,
            margin: { left: item.x, right: layout.size.w - item.x - item.w },
            head: [item.columns.map((c) => c.label)],
            body: item.rows.map((r) => r.cells),
            columns: item.columns.map((c) => ({ width: c.width, align: c.align })),
            rowRoles: item.rows.map((r) => r.role),
            headerStyle: item.headerStyle,
            scale: item.scale,
          });
          break;
      }
    }
  }

  result.pages = doc.pageCount();
  result.blob = doc.output();
  return result;
}
