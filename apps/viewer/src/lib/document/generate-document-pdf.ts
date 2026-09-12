/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Print a document (#4594): bindings resolved, blocks measured, pages
 * composed (`compose.ts`), then drawn through the report's PDF seams —
 * the same jsPDF + svg2pdf + snapshot path the coordination report uses,
 * so a chart block prints exactly as it does in a report.
 */
import type { Aggregation } from '@ifc-lite/charts';
import type { BCFTopic } from '@ifc-lite/bcf';
import { REPORT_MARGIN } from '../export/report/compose.js';
import type { ReportDoc, ReportPdfSeams } from '../export/report/generate-report-pdf.js';
import { dataUrlToBytes } from '../export/download.js';
import { renderTemplate, type BindingContext } from './bindings.js';
import { composeDocument, estimateTextWidth, type DocumentLayout, type ResolvedBlock } from './compose.js';
import type { DocumentSpec } from './types.js';

export interface DocumentPdfSeams extends ReportPdfSeams {
  /** Natural size of an image (data URL); the layout keeps its aspect ratio. */
  imageSize: (dataUrl: string) => Promise<{ w: number; h: number }>;
}

export interface DocumentPdfInput {
  document: DocumentSpec;
  bindings: BindingContext;
  /** Chart block id → its aggregation over the loaded model (`null`: cannot aggregate). */
  aggregations: Map<string, Aggregation | null>;
  /** Ids of the elements of a chart block's largest bucket, for the snapshot. */
  snapshotIds: (blockId: string) => readonly number[];
  /** BCF topics by GUID. */
  topics: Map<string, BCFTopic>;
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
export async function resolveBlocks(input: DocumentPdfInput, imageSize: DocumentPdfSeams['imageSize'], result: Pick<DocumentPdfResult, 'unresolved' | 'missingTopics'>): Promise<ResolvedBlock[]> {
  const blocks: ResolvedBlock[] = [];
  for (const block of input.document.blocks) {
    switch (block.kind) {
      case 'text': {
        const rendered = renderTemplate(block.text, input.bindings);
        for (const b of rendered.bindings) if (!b.ok) result.unresolved.push(b.path);
        blocks.push({ kind: 'text', id: block.id, style: block.style, text: rendered.text });
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
        blocks.push({ kind: 'image', id: block.id, height: block.height, align: block.align, caption: block.caption, aspect });
        break;
      }
      case 'chart': {
        const agg = input.aggregations.get(block.id) ?? null;
        const subtitle = agg ? `${agg.categories.length} bucket${agg.categories.length === 1 ? '' : 's'} · ${agg.total.toLocaleString()} ${agg.spec.measure.agg === 'count' ? 'elements' : (agg.unit ?? '')}`.trim() : 'No data';
        blocks.push({ kind: 'chart', id: block.id, title: block.chart.title, subtitle, hasData: !!agg && agg.categories.length > 0, snapshot: block.snapshot });
        break;
      }
      case 'topic': {
        const topic = input.topics.get(block.guid);
        if (!topic) {
          result.missingTopics.push(block.guid);
          blocks.push({ kind: 'topic', id: block.id, title: `[BCF topic ${block.guid}: not among the loaded topics]`, lines: [], snapshotAspect: null });
          break;
        }
        let snapshotAspect: number | null = null;
        const dataUrl = block.snapshot ? topicSnapshotDataUrl(topic) : null;
        if (dataUrl) {
          try {
            const size = await imageSize(dataUrl);
            snapshotAspect = size.w > 0 && size.h > 0 ? size.w / size.h : 4 / 3;
          } catch {
            snapshotAspect = 4 / 3;
          }
        }
        blocks.push({ kind: 'topic', id: block.id, title: topic.title, lines: topicLines(topic), snapshotAspect });
        break;
      }
    }
  }
  return blocks;
}

function drawHeaderFooter(doc: ReportDoc, layout: DocumentLayout, pageIndex: number): void {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text(layout.header, REPORT_MARGIN, REPORT_MARGIN - 8);
  doc.text(layout.footer, REPORT_MARGIN, layout.size.h - REPORT_MARGIN + 12);
  doc.text(`Page ${pageIndex + 1} / ${layout.pages.length}`, layout.size.w - REPORT_MARGIN - 60, layout.size.h - REPORT_MARGIN + 12);
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
  const result: DocumentPdfResult = { blob: new Blob(), pages: 0, unresolved: [], missingTopics: [], snapshotFailures: [], imageFailures: [] };
  const format = input.document.page.size === 'A3' ? 'a3' : 'a4';
  const doc = await seams.createDoc(format, input.document.page.orientation);
  const blocks = await resolveBlocks(input, seams.imageSize, result);

  // jsPDF measures in the font that is current, so the measure sets it first.
  const measure = (text: string, size: number, bold: boolean): number => {
    if (!doc.textWidth) return estimateTextWidth(text, size, bold);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.textWidth(text);
  };
  const layout = composeDocument({ name: input.document.name, page: input.document.page, blocks, generatedAt: seams.now().toLocaleString(), measure });
  const byId = new Map(input.document.blocks.map((b) => [b.id, b]));
  const topicsByBlock = new Map(input.document.blocks.filter((b) => b.kind === 'topic').map((b) => [b.id, input.topics.get((b as { guid: string }).guid)]));

  for (const page of layout.pages) {
    if (page.index > 0) doc.addPage(format, input.document.page.orientation);
    drawHeaderFooter(doc, layout, page.index);
    for (const item of page.items) {
      switch (item.kind) {
        case 'text':
          doc.setFont('helvetica', item.bold ? 'bold' : 'normal');
          doc.setFontSize(item.size);
          doc.setTextColor(item.gray);
          doc.text(item.text, item.x, item.y);
          doc.setTextColor(0);
          break;
        case 'image': {
          const block = byId.get(item.blockId);
          if (block?.kind === 'image') placeImage(doc, block.dataUrl || null, block.caption || 'logo', item, result);
          break;
        }
        case 'chart': {
          const agg = input.aggregations.get(item.blockId);
          if (agg && agg.categories.length > 0) {
            await doc.svg(seams.renderSvg(agg, item.w, item.h, seams.theme), item.x, item.y, item.w, item.h);
          } else {
            doc.setFontSize(9);
            doc.setTextColor(130);
            doc.text('No data for this chart.', item.x, item.y + 14);
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
        case 'topic-snapshot': {
          const topic = topicsByBlock.get(item.blockId);
          placeImage(doc, topic ? topicSnapshotDataUrl(topic) : null, topic ? `viewpoint of "${topic.title}"` : 'viewpoint', item, result);
          break;
        }
      }
    }
  }

  result.pages = doc.pageCount();
  result.blob = doc.output();
  return result;
}
