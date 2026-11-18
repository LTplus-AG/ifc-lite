/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { deleteSavedReport, detectCoincidentWalls, mountClashPanel, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { useQualityGatePreferences } from '@/lib/clash/quality-gate-preferences';
import { defaultQualityGateConfig } from '@/lib/clash/quality-gate';
import { prepareDocument } from '@/lib/document/prepare-document';
import { browserImageSize, generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { blankDocument } from '@/lib/document/presets';
import { parseDocumentFile } from '@/lib/document/persistence';
import { rebindContentDocument, rebindCommittedDocument } from '@/lib/storage/content-backup-references';
import { reportChartDependencies } from '@/lib/reports/chart-dependencies';
import type { DocumentSpec } from '@/lib/document/types';
import { DocumentPanel } from './DocumentPanel';

const original = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(original);
  useQualityGatePreferences.setState({ config: defaultQualityGateConfig() });
  localStorage.clear();
});

async function printed(document: DocumentSpec) {
  const input = await prepareDocument(document, useViewerStore.getState());
  const previous = Reflect.get(window, 'jspdf');
  Reflect.set(window, 'jspdf', await import('jspdf'));
  try {
    const result = await generateDocumentPdf(input, { ...await browserReportSeams(null), imageSize: browserImageSize });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const require = createRequire(import.meta.url);
    const task = pdfjs.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
      standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
    try {
      const page = await (await task.promise).getPage(1);
      const content = await page.getTextContent();
      page.cleanup();
      return { text: content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' '), failures: result.qualityGateFailures };
    } finally { await task.destroy(); }
  } finally { Reflect.set(window, 'jspdf', previous); }
}

it('places, refreshes, prints, and reports deletion of a saved quality gate inside an existing page (#10458)', async () => {
  mountClashPanel();
  await detectCoincidentWalls(2);
  const before = await saveCurrentResultAs('First coordination check');
  cleanup();

  const config = defaultQualityGateConfig();
  config.duplicates = [{ minimum: 0, label: 'Review needed', color: '#9a3412' }, { minimum: 85, label: 'Accepted', color: '#047857' }];
  assert.equal(useQualityGatePreferences.getState().save(config), true);
  const clash = mountClashPanel();
  await detectCoincidentWalls(3);
  const button = (name: RegExp) => [...clash.querySelectorAll('button')].find(item => name.test(item.textContent?.trim() ?? ''));
  if (!button(/^Find duplicates$/)) {
    const detection = button(/^Detection/);
    assert.ok(detection);
    click(detection);
  }
  const duplicates = button(/^Find duplicates$/);
  assert.ok(duplicates);
  const run = useViewerStore.getState().clashRunSeq;
  await act(async () => {
    duplicates.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  await waitFor(() => useViewerStore.getState().clashRunSeq > run && !useViewerStore.getState().clashRunning, 'the duplicate check completes');
  const after = await saveCurrentResultAs('Revised coordination check');
  assert.equal(after.qualityGates?.rows[0].kind, 'duplicates');
  cleanup();

  const doc: DocumentSpec = { ...blankDocument(), blocks: [{ kind: 'text', id: 'earlier-note', style: 'body', text: 'Existing page note' }] };
  const state = useViewerStore.getState();
  assert.equal(await state.upsertDocument(doc), true);
  state.setActiveDocumentId(doc.id);
  const savedDoc = () => {
    const current = useViewerStore.getState().documents.find(item => item.id === doc.id);
    assert.ok(current);
    return current;
  };
  const ui = render(<DocumentPanel />);
  const trigger = [...ui.querySelectorAll('button')].find(button => button.title === 'Add a block to the page');
  assert.ok(trigger);
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
  const add = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Quality gate');
  assert.ok(add);
  click(add);
  const gate = savedDoc().blocks[1];
  assert.ok(gate?.kind === 'quality-gate', 'the add menu puts a movable block inside the current document');
  const select = [...ui.querySelectorAll('[role="combobox"]')].find(element =>
    document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent === 'Saved check report');
  assert.ok(select);
  const choose = (name: string) => {
    click(select);
    const option = [...document.querySelectorAll('[role="option"]')].find(item => item.textContent?.startsWith(name));
    assert.ok(option);
    click(option);
  };
  const preview = () => ui.querySelector(`[data-preview-block="${gate.id}"]`);
  choose(before.name);
  await documentPreviewReady({ root: ui });
  await waitFor(() => !!preview()?.textContent?.includes('2 checked'), 'the first saved report renders');
  assert.match(preview()?.textContent ?? '', /2 checked · 2 affected/);
  assert.match(preview()?.textContent ?? '', /0\.0% · Failed/);
  assert.ok(preview()?.querySelector('img[alt="0.0%"]'));

  choose(after.name);
  await waitFor(() => !!preview()?.textContent?.includes('3 checked'), 'the same preview block refreshes after selection');
  assert.match(preview()?.textContent ?? '', /3 checked · 3 affected/);
  assert.match(preview()?.textContent ?? '', /0\.0% · Review needed/);
  assert.match(decodeURIComponent(preview()?.querySelector('img')?.getAttribute('src') ?? ''), /stroke="#e5e7eb"/);
  const move = ui.querySelector(`[data-block-editor="${gate.id}"] button[aria-label="Move block up"]`);
  assert.ok(move);
  click(move);
  const revised = savedDoc();
  assert.deepEqual(revised.blocks.map(block => block.id), [gate.id, 'earlier-note']);
  const dependency = reportChartDependencies(useViewerStore.getState(), { kind: 'clash', id: after.id });
  assert.equal(dependency.total, 1);
  assert.equal(dependency.hasQualityGates, true);

  const output = await printed(revised);
  assert.match(output.text, /Review needed.*Existing page note/);
  assert.match(output.text, /3 checked · 3 affected/);
  assert.match(output.text, /0\.0% · Review needed/);
  assert.equal(output.failures, undefined);

  mountClashPanel();
  await deleteSavedReport(after);
  await waitFor(() => !!preview()?.textContent?.includes('unavailable'), 'deleting the saved report updates the preview');
  assert.equal(preview()?.querySelector('img'), null);
  const missing = await printed(revised);
  assert.match(missing.text, /The selected saved quality gate is unavailable/);
  assert.deepEqual(missing.failures, [gate.id]);
});

it('migrates existing documents and retains the selected quality gate row when a backup remaps its report (#10458)', () => {
  const old = { ...blankDocument(), version: 13 };
  assert.deepEqual(parseDocumentFile(JSON.stringify(old)).blocks.map(block => ({ ...block, id: '' })), old.blocks.map(block => ({ ...block, id: '' })));
  const prior: DocumentSpec = { ...blankDocument(), blocks: [{ kind: 'quality-gate', id: 'gate', clashReportId: 'source', row: 2 }] };
  const parsed = parseDocumentFile(JSON.stringify(prior));
  const imported = parsed.blocks[0];
  assert.ok(imported?.kind === 'quality-gate');
  assert.notEqual(imported.id, prior.blocks[0].id);
  assert.equal(imported.clashReportId, 'source');
  assert.equal(imported.row, 2);
  const target = rebindContentDocument(prior, new Map(), new Map(), new Map([['source', 'imported']]));
  const gate = target.blocks[0];
  assert.ok(gate?.kind === 'quality-gate');
  assert.equal(gate.clashReportId, 'imported');
  assert.equal(gate.row, 2);
  const current = { ...prior, name: 'Edited while writing' };
  assert.deepEqual(rebindCommittedDocument(current, prior, target), { ...target, name: current.name });
});
