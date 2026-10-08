/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Document evidence adapter (#6833): the active native document's blocks
 * in order, text as unresolved templates with their bindings, images, logos
 * and charts as metadata only, with native totals and replacement staleness.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { newChartSpec } from '@/lib/charts/presets';
import { DOCUMENT_VERSION, validateDocumentSpec, type DocumentBlock, type DocumentSpec } from '@/lib/document/types';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '@/lib/assistant/evidence';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const PIXELS = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LdsAAAAASUVORK5CYII=';
const blocks: DocumentBlock[] = [
  { kind: 'text', id: 'title', style: 'title', text: '{IfcProject.Name} - {IfcBuilding.Name} {{literal}}', title: 'Cover' },
  { kind: 'image', id: 'logo', dataUrl: `data:image/png;base64,${PIXELS}`, height: 60, align: 'center', caption: 'Logo' },
  { kind: 'chart', id: 'chart', chart: newChartSpec(), snapshot: false, title: 'Counts', height: 180 },
  { kind: 'topic', id: 'topic', guid: '0bcf-topic-source', snapshot: true },
  { kind: 'page-break', id: 'break' },
  { kind: 'table', id: 'table', source: { kind: 'validation', ruleId: 'rule-1', rows: 'failed', columns: ['name', 'globalId'] }, maxRows: 8 },
  { kind: 'ids-report', id: 'ids', sourceName: 'Delivery', generatedAt: new Date(0).toISOString(), summary: { checked: 4, passed: 3, failed: 1, passRate: 75 }, checks: [] },
];
const spec = (id: string, content: DocumentBlock[]): DocumentSpec => ({ version: DOCUMENT_VERSION, id, name: 'Handover', page: { size: 'A3', orientation: 'landscape' },
  pageFooter: { text: 'Page for {IfcProject.Name}', logo: { dataUrl: `data:image/jpeg;base64,${PIXELS}`, height: 20 }, showPageNumbers: true }, blocks: content });

const payloadOf = (snapshot: ReturnType<typeof captureEvidence>) => JSON.parse(snapshot.payload) as {
  totalRows: number; includedRows: number; sampled: boolean; sourceAvailability: string;
  evidence: { summary: Record<string, unknown>; rows: Array<{ citation: string; data: Record<string, unknown> }> };
};

test('#6833 the Document header attaches the active native document without image data', async () => {
  const document = spec('doc-1', blocks);
  assert.deepEqual(validateDocumentSpec(document), []);
  await act(async () => {
    assert.equal(await useViewerStore.getState().upsertDocument(document), true);
    useViewerStore.getState().setActiveDocumentId(document.id);
  });
  const root = render(renderPanelBody('document', () => undefined));
  await waitFor(() => root.querySelector('button[aria-label="Discuss with AI"]') !== null, 'Document panel mounted');
  click(root.querySelector('button[aria-label="Discuss with AI"]')!);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'document');
  assert.ok(snapshot);
  assert.doesNotMatch(snapshot.payload, new RegExp(PIXELS.slice(0, 24)), 'no image or logo pixels in evidence');
  const payload = payloadOf(snapshot);
  assert.equal(payload.totalRows, blocks.length);
  assert.deepEqual(payload.evidence.summary.page, { size: 'A3', orientation: 'landscape' });
  assert.deepEqual(payload.evidence.summary.blockCounts, { text: 1, image: 1, chart: 1, topic: 1, 'page-break': 1, table: 1, 'ids-report': 1 });
  assert.deepEqual(payload.evidence.summary.pageFooter, { text: 'Page for {IfcProject.Name}', bindings: ['IfcProject.Name'],
    logo: { mediaType: 'image/jpeg', heightPt: 20 }, showDate: null, showPageNumbers: true });
  const [text, image, chart, , , table, report] = payload.evidence.rows.map(row => row.data);
  assert.deepEqual(text.bindings, ['IfcProject.Name', 'IfcBuilding.Name'], 'double braces are literal, not bindings');
  assert.equal(text.title, 'Cover');
  assert.deepEqual([image.mediaType, image.heightPt, image.caption], ['image/png', 60, 'Logo']);
  assert.equal(chart.chartTitle, blocks[2].kind === 'chart' ? blocks[2].chart.title : null);
  assert.deepEqual([table.sourceKind, table.ruleId, table.rows], ['validation', 'rule-1', 'failed']);
  assert.deepEqual([report.reportSource, report.sourceName, report.reportSummary], ['ids', 'Delivery', { checked: 4, passed: 3, failed: 1, passRate: 75 }]);
  assert.equal(evidenceIsCurrent(snapshot), true);

  await act(async () => { await useViewerStore.getState().upsertDocument({ ...document, name: 'Renamed' }); });
  assert.equal(evidenceIsCurrent(snapshot), false, 'editing the document makes the evidence stale');
});

test('#6833 document evidence keeps the native block total over a sample and is unavailable without an active document', () => {
  assert.equal(payloadOf(captureEvidence('document')).sourceAvailability, 'unavailable');
  const long = spec('doc-long', Array.from({ length: 130 }, (_, i): DocumentBlock => ({ kind: 'text', id: `t${i}`, style: 'body', text: `Paragraph ${i} ${'x'.repeat(2000)}` })));
  useViewerStore.setState({ documents: [long], activeDocumentId: 'doc-long' });
  const payload = payloadOf(captureEvidence('document'));
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(payload.totalRows, 130);
  assert.equal(payload.evidence.summary.blockCount, 130);
  assert.ok(payload.includedRows <= 100);
  assert.equal(payload.sampled, true);
  const first = payload.evidence.rows[0].data;
  assert.equal(first.textLength, 2000 + 'Paragraph 0 '.length);
  assert.ok((first.textExcerpt as string).length <= 401, 'text excerpts are bounded');

  useViewerStore.setState({ activeDocumentId: 'missing' });
  assert.equal(payloadOf(captureEvidence('document')).sourceAvailability, 'unavailable', 'a dangling active id is not a document');
});

test('#6947 a document chart bound to saved content is described as bound, not as its live source', () => {
  const bar = { type: 'bar', measure: { agg: 'count' } } as const;
  const document = spec('doc-bound', [
    { kind: 'chart', id: 'current', snapshot: false, chart: { ...bar, id: 'current', title: 'Current', source: 'clash', dimension: 'Rule' } },
    { kind: 'chart', id: 'saved-run', snapshot: false, chart: { ...bar, id: 'saved-run', title: 'Saved run', source: 'clash', dimension: 'Rule', clashReportId: 'clash-report-1' } },
    { kind: 'chart', id: 'saved-compare', snapshot: false, chart: { ...bar, id: 'saved-compare', title: 'Saved comparison', source: 'compare', dimension: 'State', comparisonId: 'comparison-1' } },
  ]);
  assert.deepEqual(validateDocumentSpec(document), []);
  useViewerStore.setState({ documents: [document], activeDocumentId: document.id });
  const rows = payloadOf(captureEvidence('document')).evidence.rows.map(row => row.data);
  // `chartSource` alone reads "clash" for the first two: a conversation would describe a saved run as the current result.
  assert.deepEqual(rows.map(row => [row.chartSource, row.savedSource]),
    [['clash', null], ['clash', 'clashReport'], ['compare', 'comparison']]);
});
