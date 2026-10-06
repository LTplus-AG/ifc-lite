/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Document panel's active document (#6833). Native owner: `documents` /
 * `activeDocumentId` (`DocumentSpec`, `lib/document/types`). Text travels as
 * its unresolved template with the `{path}` bindings it names; images, logos
 * and charts travel as metadata only, never data URLs or rendered output.
 */

import { templatePaths } from '@/lib/document/bindings';
import { reportBlockSourceKind, type DocumentBlock, type DocumentSpec, type TableSource } from '@/lib/document/types';
import type { PageBand } from '@/lib/document/page-band';
import type { ViewerState } from '@/store';
import { evidenceRow, take, unavailableCapture, type EvidenceAdapter } from './types';

const TEXT = 400;

const bounded = (text: string, limit = TEXT): string => text.length > limit ? `${text.slice(0, limit)}…` : text;
const mediaType = (dataUrl: string): string | null => /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? null;

function activeDocument(s: ViewerState): DocumentSpec | null {
  return s.activeDocumentId === null ? null : s.documents.find(document => document.id === s.activeDocumentId) ?? null;
}

function band(value: PageBand | undefined) {
  if (!value) return null;
  return { text: value.text === undefined ? null : bounded(value.text, 200), bindings: value.text ? templatePaths(value.text).slice(0, 20) : [],
    logo: value.logo ? { mediaType: mediaType(value.logo.dataUrl), heightPt: value.logo.height } : null,
    showDate: value.showDate ?? null, showPageNumbers: value.showPageNumbers ?? null };
}

function tableSource(source: TableSource) {
  switch (source.kind) {
    case 'list': return { sourceKind: 'list', listName: source.list.name, fromListId: source.fromListId ?? null };
    case 'validation': return { sourceKind: 'validation', ruleId: source.ruleId ?? null, rows: source.rows, columns: source.columns };
    case 'comparison': return { sourceKind: 'comparison', comparisonName: source.comparison.name, savedAt: source.comparison.savedAt };
  }
}

function blockFields(block: DocumentBlock): Record<string, unknown> {
  switch (block.kind) {
    case 'text': {
      const bindings = templatePaths(block.text);
      return { style: block.style, textLength: block.text.length, textExcerpt: bounded(block.text),
        bindingCount: bindings.length, bindings: bindings.slice(0, 20) };
    }
    case 'image':
      return { mediaType: mediaType(block.dataUrl), encodedLength: block.dataUrl.length, heightPt: block.height,
        align: block.align, caption: block.caption === undefined ? null : bounded(block.caption, 200) };
    case 'chart':
      return { chartTitle: block.chart.title, chartType: block.chart.type, chartSource: block.chart.source,
        dimension: block.chart.dimension ?? null, measure: block.chart.measure, filtered: block.chart.filter !== undefined,
        snapshot: block.snapshot };
    case 'topic': return { topicGuid: block.guid, snapshot: block.snapshot };
    case 'spacer': return { heightPt: block.height };
    case 'page-break': return {};
    case 'table': return { ...tableSource(block.source), maxRows: block.maxRows ?? null, caption: block.caption ?? null };
    case 'ids-report':
      return { reportSource: reportBlockSourceKind(block), sourceName: block.sourceName, generatedAt: block.generatedAt,
        reportSummary: block.summary, checkCount: block.checks.length, variant: block.variant ?? null };
    case 'manual-report':
      return { checklistName: block.checklistName, generatedAt: block.generatedAt, modelName: block.modelName ?? null,
        reportSummary: block.summary, groupCount: block.groups.length };
  }
}

function blockRow(block: DocumentBlock, index: number) {
  const title = 'title' in block && typeof block.title === 'string' ? block.title : null;
  return evidenceRow({ kind: 'block' }, { blockId: block.id, blockKind: block.kind, position: index + 1, title, ...blockFields(block) });
}

function* documentRows(document: DocumentSpec) {
  let index = 0;
  for (const block of document.blocks) yield blockRow(block, index++);
}

export const documentAdapter: EvidenceAdapter = {
  id: 'document', group: 'automation', panelIds: ['document'],
  titleKey: 'workspacePanels.bottom.document', descriptionKey: 'assistantSources.document.description',
  rowMeaningKey: 'assistantSources.document.rows', unavailableKey: 'assistantSources.document.unavailable',
  suggestionKeys: ['assistantSources.document.suggestReview', 'assistantSources.document.suggestBindings'],
  readiness: s => {
    const document = activeDocument(s);
    return document
      ? { status: { labelKey: 'assistantSources.document.status', params: { name: document.name, count: document.blocks.length } }, ready: true }
      : { status: { labelKey: 'assistantSources.document.statusNone' }, ready: false };
  },
  identity: s => activeDocument(s),
  capture: (s, limit) => {
    const document = activeDocument(s);
    if (!document) return unavailableCapture();
    const blockCounts: Record<string, number> = {};
    for (const block of document.blocks) blockCounts[block.kind] = (blockCounts[block.kind] ?? 0) + 1;
    return {
      summary: {
        kind: 'document', documentId: document.id, name: document.name, version: document.version,
        page: document.page, pageHeading: band(document.pageHeading), pageFooter: band(document.pageFooter),
        blockCount: document.blocks.length, blockCounts, units: { heightPt: 'pt', encodedLength: 'characters' },
        documentsInLibrary: s.documents.length,
        limitations: 'Text is the authored template: {path} bindings are listed but not resolved against the model, so the printed values are not '
          + 'included. Images and logos are metadata only (no pixels); charts give their definition, not their computed buckets; tables give their '
          + 'source, not their rows; validation and checklist blocks give the counts frozen when they were added. Text excerpts are bounded.',
      },
      rows: take(documentRows(document), limit),
      totalRows: document.blocks.length,
      availability: 'available',
    };
  },
};
