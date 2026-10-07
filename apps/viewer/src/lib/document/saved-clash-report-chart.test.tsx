/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A document chart bound to a saved clash report (#6947): the preview and the
 * PDF read the same saved rows and print the same provenance, a partial run
 * says so on paper, and a deleted report is reported as a failed chart rather
 * than printed from the current result.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { act } from 'react';
import * as jspdf from 'jspdf';
import type { ChartSpec } from '@ifc-lite/charts';
import { DocumentPreview } from '@/components/viewer/document/DocumentPreview';
import { useDocumentData, type DocumentData } from '@/components/viewer/document/useDocumentData';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render';
import { installSvgCdataEnvironmentConversion } from '@/test/svg-cdata';
import { deleteSavedReport, detectCoincidentWalls, mountClashPanel, publishCappedRun, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { documentPdfWarnings } from './export-prepared-document';
import { browserImageSize, generateDocumentPdf } from './generate-document-pdf';
import { blankDocument } from './presets';
import { prepareDocument } from './prepare-document';
import type { DocumentSpec } from './types';

const original = useViewerStore.getState();
beforeEach(() => {
  localStorage.clear();
  act(() => useViewerStore.setState({ mutationVersion: 0, mutationViews: new Map(), clashReviews: new Map(), clashExclusions: [] }));
});
afterEach(() => { cleanup(); useViewerStore.setState(original); localStorage.clear(); });

const settle = async () => { for (let index = 0; index < 6; index++) await act(async () => { await Promise.resolve(); }); };
const chart = (clashReportId?: string): ChartSpec => ({ id: 'saved-run-chart', title: 'Clashes by rule', source: 'clash', type: 'bar', dimension: 'Rule',
  measure: { agg: 'count' }, ...(clashReportId ? { clashReportId } : {}) });
const documentFor = (spec: ChartSpec): DocumentSpec => ({ ...blankDocument(), name: 'Coordination report',
  blocks: [{ kind: 'chart', id: 'clash-block', chart: spec, snapshot: true }] });

function Probe({ document, observe }: { document: DocumentSpec; observe: (data: DocumentData) => void }) {
  const data = useDocumentData(document); observe(data);
  return <DocumentPreview document={document} {...data} selectedBlockId={null} onSelectBlock={() => {}} />;
}

/** Print through the real jsPDF path and read the text back with pdf.js; `snapshots` counts the 3D snapshots it asked for. */
async function print(document: DocumentSpec): Promise<{ text: string; warnings: string[]; snapshots: number }> {
  const prepared = await prepareDocument(document, useViewerStore.getState());
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const previous = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
  let snapshots = 0;
  // Happy DOM's XML parser needs the chart SVG's CDATA converted, as in the saved comparison chart test.
  const restoreParser = installSvgCdataEnvironmentConversion();
  try {
    const seams = { ...await browserReportSeams(null), imageSize: browserImageSize,
      capture: async () => { snapshots++; return undefined; } };
    const result = await generateDocumentPdf({ ...prepared, document, snapshotIds: () => [] }, seams);
    const reader = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const task = reader.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
      standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
    try {
      const pdf = await task.promise, text: string[] = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number);
        try { text.push(...(await page.getTextContent()).items.flatMap((item) => 'str' in item ? [item.str] : [])); }
        finally { page.cleanup(); }
      }
      return { text: text.join(' ').replace(/\s+/g, ' '), warnings: documentPdfWarnings(result), snapshots };
    } finally { await task.destroy(); }
  } finally { restoreParser(); pdfWindow.jspdf = previous; }
}

describe('Document chart bound to a saved clash report (#6947)', () => {
  it('preview and PDF read the saved rows, not a later run, and the PDF states the provenance and that the run was partial', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    await publishCappedRun();
    const saved = await saveCurrentResultAs('Capped run');
    const recorded = saved.clashes.length;
    await detectCoincidentWalls(4);
    assert.notEqual(recorded, 6, 'the later run has a different population');

    const document = documentFor(chart(saved.id));
    let data: DocumentData | undefined;
    render(<Probe document={document} observe={(value) => { data = value; }} />); await settle();
    assert.equal(data?.aggregations.get('clash-block')?.total, recorded, 'the preview aggregates the saved rows');
    assert.equal(data?.chartErrors?.has('clash-block'), false, 'a saved source is provenance, not a failure');
    const caption = data?.chartMessages.get('clash-block') ?? '';
    assert.match(caption, /^Partial run · .*Saved clash report: Capped run, saved /, 'the limit leads the caption, so fitting it to the column cannot cut it off');

    const printed = await print(document);
    assert.deepEqual(printed.warnings, []);
    assert.equal(printed.snapshots, 0, 'saved rows name no loaded element, so the block asks for no 3D snapshot of whatever is loaded');
    assert.match(printed.text, /Saved clash report: Capped run, saved /, 'the PDF prints which report the chart shows');
    assert.match(printed.text, /Partial run · /, 'and that the run was partial');
    const live = await print(documentFor(chart()));
    assert.doesNotMatch(live.text, /Saved clash report|Partial run/, 'control: an unbound chart of the current result prints no such statement');
    assert.equal(live.snapshots, 1, 'control: the same block on the current result does ask for its snapshot');
  });

  it('a deleted report prints as an unavailable chart in the preview and the PDF, never as the current result', async () => {
    mountClashPanel();
    await detectCoincidentWalls(2);
    const saved = await saveCurrentResultAs('Run A');
    await detectCoincidentWalls(3);
    const document = documentFor(chart(saved.id));
    let data: DocumentData | undefined;
    const ui = render(<Probe document={document} observe={(value) => { data = value; }} />); await settle();
    assert.equal(data?.aggregations.get('clash-block')?.total, 1);

    await deleteSavedReport(saved); await settle();
    assert.equal(data?.aggregations.get('clash-block')?.total, 0, 'the three clashes of the current result are not shown instead');
    assert.equal(data?.chartErrors?.has('clash-block'), true);
    assert.match(ui.textContent ?? '', /Saved clash report unavailable in this browser\./);
    const printed = await print(document);
    assert.ok(printed.warnings.some((warning) => warning.includes('Saved clash report unavailable')), 'the export reports the chart as failed');
    assert.match(printed.text, /Saved clash report unavailable in this browser\./);
    assert.match(printed.text, /the current result is not shown in its place/);
  });
});
