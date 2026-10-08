/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as jspdf from 'jspdf';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, click, cleanup, waitFor } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { activityCanceller, useActivityJournal } from '@/lib/activity/activity-journal';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { DocumentPanel } from './DocumentPanel';
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial); useActivityJournal.setState({ jobs: [] }); });
async function pdfText(blob: Blob) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await blob.arrayBuffer()),
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent(); page.cleanup();
    return content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ');
  } finally { await task.destroy(); }
}
for (const refused of [false, true]) it(`#7128 native document PDF ${refused ? 'download failure' : 'publication'} settles Activity without invented Cancel`, async () => {
  useActivityJournal.setState({ jobs: [] });
  const bytes = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const model = { ...fixtureModel('authored-document'), ifcDataStore: store };
  const documentSpec: DocumentSpec = { version: DOCUMENT_VERSION, id: 'native-document', name: 'Native document',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'count', style: 'body', text: 'Authored walls: {Count[IfcWall]}' }] };
  useViewerStore.setState({ ...fixtureModels(model), dashboards: [], documents: [], activeDocumentId: null, bcfProject: null });
  await useViewerStore.getState().upsertDocument(documentSpec);
  useViewerStore.getState().setActiveDocumentId(documentSpec.id);
  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let printed: Blob | undefined;
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const previousJspdf = pdfWindow.jspdf;
  pdfWindow.jspdf = jspdf;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, anchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = ((blob: Blob) => {
    if (blob.type === 'application/pdf') { if (refused) throw new Error('Native PDF download refused #7128'); printed = blob; }
    return 'blob:native-document';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
  try {
    const ui = render(<DocumentPanel pdfSeams={async () => { await gate; return browserReportSeams(null); }} />);
    await documentPreviewReady();
    const exportButton = [...ui.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Export PDF');
    assert.ok(exportButton); click(exportButton);
    const row = useActivityJournal.getState().jobs.at(-1)!;
    assert.equal(row.outcome, 'running');
    assert.equal(activityCanceller(row.id), null, 'PDF writer has no native abort controller');
    await act(async () => release());
    await waitFor(() => useActivityJournal.getState().jobs.at(-1)?.outcome !== 'running', 'native PDF publication settled');
    const finished = useActivityJournal.getState().jobs.at(-1)!;
    assert.equal(finished.outcome, refused ? 'failed' : 'completed');
    assert.equal(activityCanceller(row.id), null);
    if (refused) { assert.equal(printed, undefined); assert.match(finished.detail ?? '', /Native PDF download refused #7128/); }
    else {
      assert.ok(printed); assert.match(await pdfText(printed), new RegExp(`Authored walls: ${store.entityIndex.byType.get('IFCWALL')?.length}`));
    }
  } finally {
    release(); URL.createObjectURL = create; URL.revokeObjectURL = revoke;
    HTMLAnchorElement.prototype.click = anchorClick; pdfWindow.jspdf = previousJspdf;
  }
});
