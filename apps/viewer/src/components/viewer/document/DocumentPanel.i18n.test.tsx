/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Regression coverage for the #4918 document-panel localization slice: DocumentPanel.tsx's own
 *  header chrome, "Add block" menu, empty state, and the pluralized export-result toast all read
 *  the catalogue and re-render in a registered locale. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_THEME, renderChartSvg } from '@ifc-lite/charts';
import { Toaster } from '@/components/ui/toast';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store/index.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { DocumentPanel } from './DocumentPanel.js';

const TEST_LOCALE: Catalogue = {
  'document.panel.selectAriaLabel': 'Dokument',
  'document.panel.pageLabel': 'Seite',
  'document.panel.orientationAriaLabel': 'Ausrichtung',
  'document.addBlock.buttonTitle': 'Einen Block zur Seite hinzufügen',
  'document.addBlock.button': 'Block hinzufügen',
  'document.addBlock.text': 'Text mit Feldern',
  'document.addBlock.image': 'Bild / Logo',
  'document.addBlock.table': 'Validierungsergebnis-Tabelle',
  'document.panel.exportTitle': 'Diese Seite als PDF drucken',
  'document.panel.closeAriaLabel': 'Dokumentbereich schließen',
  'document.panel.emptyBlocks': 'Noch keine Blöcke — "Block hinzufügen" oben.',
  'document.panel.exportSuccessWithProblems': {
    one: 'Dokument exportiert: {countDisplay} Seite ({problems})',
    other: 'Dokument exportiert: {countDisplay} Seiten ({problems})',
  },
  'document.panel.problemUnresolved': {
    one: '{countDisplay} Bindung nicht aufgelöst',
    other: '{countDisplay} Bindungen nicht aufgelöst',
  },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

function openMenu(trigger: HTMLElement): void {
  act(() => trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true })));
  act(() => trigger.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));
}

describe('DocumentPanel localization (#4918)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      models: new Map(),
      activeModelId: null,
      documents: [],
      activeDocumentId: null,
      dashboards: [],
      bcfProject: null,
      selectedEntityIds: new Set(),
    });
  });
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('translates the header chrome, the "Add block" menu, and falls back to English per missing key', async () => {
    const onClose = (): void => {};
    const ui = render(<DocumentPanel onClose={onClose} />);
    await settle();

    assert.ok(ui.querySelector('select[aria-label="Document"]'));
    assert.equal(ui.textContent?.includes('Page'), true);
    assert.ok(ui.querySelector('button[aria-label="Close document panel"]'));
    const trigger = [...ui.querySelectorAll('button')].find((b) => b.title === 'Add a block to the page')!;
    assert.ok(trigger);
    openMenu(trigger);
    assert.match(document.body.textContent ?? '', /Text with fields/);
    assert.match(document.body.textContent ?? '', /Image \/ logo/);
    assert.match(document.body.textContent ?? '', /Validation results table/);
    act(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    registerLocale('document-panel-x', TEST_LOCALE);
    act(() => setLocale('document-panel-x'));

    assert.ok(ui.querySelector('select[aria-label="Dokument"]'));
    assert.equal(ui.textContent?.includes('Seite'), true);
    assert.ok(ui.querySelector('button[aria-label="Dokumentbereich schließen"]'));
    const translatedTrigger = [...ui.querySelectorAll('button')].find((b) => b.title === 'Einen Block zur Seite hinzufügen')!;
    assert.ok(translatedTrigger, 'the trigger picks up the registered title');
    assert.equal(translatedTrigger.textContent?.includes('Block hinzufügen'), true);
    openMenu(translatedTrigger);
    assert.match(document.body.textContent ?? '', /Text mit Feldern/);
    assert.match(document.body.textContent ?? '', /Bild \/ Logo/);
    assert.match(document.body.textContent ?? '', /Validierungsergebnis-Tabelle/);
    // Orientation has no override in this registered locale: falls back to English rather than
    // going blank.
    assert.match(document.body.textContent ?? '', /Portrait/);
  });

  it('shows the "no blocks yet" empty state translated once every seeded block is removed', async () => {
    const ui = render(<DocumentPanel />);
    await settle();
    for (const button of [...ui.querySelectorAll('button[aria-label="Remove block"]')]) click(button);
    await settle();
    assert.equal(ui.textContent?.includes('No blocks yet'), true);

    registerLocale('document-panel-x-empty', TEST_LOCALE);
    act(() => setLocale('document-panel-x-empty'));
    assert.equal(ui.textContent?.includes('Noch keine Blöcke'), true);
  });

  it('translates the pluralized export-result toast, keeping its {countDisplay}/{problems} values live', async () => {
    registerLocale('document-panel-x-export', TEST_LOCALE);
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async () => ({
        addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
        text: () => {}, addImage: () => {}, svg: async () => {}, table: () => {},
        pageCount: () => 1, output: () => new Blob(['pdf']),
      }),
      renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
      capture: async (ids) => new Uint8Array(ids.length),
      theme: DEFAULT_THEME,
      now: () => new Date(0),
      imageSize: async () => ({ w: 2, h: 1 }),
    });
    act(() => setLocale('document-panel-x-export'));
    const ui = render(<><DocumentPanel pdfSeams={seams} /><Toaster /></>);
    await settle();
    // The seeded blank document's title block reads {IfcProject.Name}: unresolved with no model
    // loaded, so the export reports exactly one unresolved binding.
    click(ui.querySelector('[data-document-export]')!);
    let toastText = '';
    for (let i = 0; i < 20 && !toastText; i++) {
      await settle();
      toastText = document.body.querySelector('[data-sonner-toast], [role="status"]')?.textContent ?? document.body.textContent ?? '';
      if (!/exportiert|Dokument/.test(toastText)) toastText = '';
    }
    assert.match(toastText, /Dokument exportiert: 1 Seite \(1 Bindung nicht aufgelöst\)/);
  });
});
