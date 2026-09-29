/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6370: a Text block behaves like a normal text box. A line break typed in
 * the editor is kept, shows as a line break in the preview for every text
 * style (it collapsed into one line for Title, Heading and Subheading), prints
 * as a separate line in the PDF and survives a template export/import. Tab
 * indents instead of leaving the field; Escape then Tab leaves it, so the
 * keyboard is never trapped.
 */
import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_THEME, renderChartSvg } from '@ifc-lite/charts';
import { useViewerStore } from '@/store/index.js';
import { render, cleanup, type } from '@/test/render.js';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events.js';
import type { DocumentPdfSeams } from '@/lib/document/generate-document-pdf.js';
import { loadDocuments, parseDocumentFile } from '@/lib/document/persistence.js';
import { DOCUMENT_VERSION, type DocumentSpec, type TextBlock } from '@/lib/document/types.js';
import { DocumentPanel } from './DocumentPanel.js';

const REPORTED = 'Prüfbericht\nBIM-Gesamtkoordination';

function seedDocument(style: TextBlock['style'], text = ''): void {
  const doc: DocumentSpec = {
    version: DOCUMENT_VERSION,
    id: 'doc-6370',
    name: 'Check report',
    page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'text', id: 'text-6370', style, text }],
  };
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    documents: [doc],
    activeDocumentId: doc.id,
    dashboards: [],
    bcfProject: null,
    selectedEntityIds: new Set(),
    mutationViews: new Map(),
    mutationVersion: 0,
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}

const storedText = (): string => (useViewerStore.getState().documents[0].blocks[0] as TextBlock).text;

/** Dispatch a keydown the way the browser does and report whether its default (the native edit or focus move) survives. */
function keyDown(target: HTMLElement, key: string, init: KeyboardEventInit = {}): boolean {
  let proceed = true;
  act(() => {
    proceed = target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
  return proceed;
}

function editor(ui: HTMLElement): HTMLTextAreaElement {
  const textarea = ui.querySelector<HTMLTextAreaElement>('[data-block-editor="text-6370"] textarea');
  assert.ok(textarea, 'the text block has its editor');
  return textarea;
}

function previewText(ui: HTMLElement): HTMLElement {
  const preview = ui.querySelector<HTMLElement>('[data-preview-block="text-6370"] [data-block-text]');
  assert.ok(preview, 'the text block is on the page');
  return preview;
}

describe('Document Text block line breaks and indentation (#6370)', () => {
  afterEach(() => cleanup());

  for (const style of ['title', 'heading', 'subheading', 'body', 'small', 'caption'] as const) {
    it(`Enter is left to the text box and the break shows in the ${style} preview`, async () => {
      seedDocument(style);
      const ui = render(<DocumentPanel />);
      await settle();
      const textarea = editor(ui);
      textarea.focus();
      assert.equal(keyDown(textarea, 'Enter'), true, 'nothing cancels Enter, so the browser inserts the line break');
      type(textarea, REPORTED);
      await settle();
      assert.equal(storedText(), REPORTED, 'the line break is saved in the block');
      const preview = previewText(ui);
      assert.equal(preview.textContent, REPORTED);
      // `pre-wrap` is what turns the stored "\n" into a visible line break (and keeps a tab's indent).
      assert.equal(window.getComputedStyle(preview).whiteSpace, 'pre-wrap', `${style} keeps line breaks`);
    });
  }

  it('Tab indents at the caret, Shift+Tab takes it back, and Escape then Tab leaves the field', async () => {
    seedDocument('body', 'Project\nName');
    const ui = render(<DocumentPanel />);
    await settle();
    const textarea = editor(ui);
    textarea.focus();
    textarea.setSelectionRange(8, 8); // start of "Name"
    assert.equal(keyDown(textarea, 'Tab'), false, 'Tab is taken by the text box, focus stays');
    await settle();
    assert.equal(storedText(), 'Project\n\tName');
    assert.equal(textarea.selectionStart, 9, 'the caret follows the inserted tab');
    assert.equal(textarea.selectionEnd, 9);

    assert.equal(keyDown(textarea, 'Tab', { shiftKey: true }), false);
    await settle();
    assert.equal(storedText(), 'Project\nName', 'Shift+Tab removes the indent again');
    assert.equal(textarea.selectionStart, 8);

    // The keyboard is never trapped: Escape arms the exit, the next Tab moves focus as usual.
    assert.equal(keyDown(textarea, 'Escape'), true);
    assert.equal(keyDown(textarea, 'Tab'), true, 'after Escape, Tab is left to the browser to move focus');
    await settle();
    assert.equal(storedText(), 'Project\nName', 'and nothing was inserted');

    // Shift on its own keeps the exit armed, so Esc, Shift+Tab leaves backwards.
    assert.equal(keyDown(textarea, 'Escape'), true);
    assert.equal(keyDown(textarea, 'Shift', { shiftKey: true }), true);
    assert.equal(keyDown(textarea, 'Tab', { shiftKey: true }), true, 'Esc then Shift+Tab also leaves');

    // Any other key disarms it again.
    assert.equal(keyDown(textarea, 'Escape'), true);
    assert.equal(keyDown(textarea, 'a'), true);
    textarea.setSelectionRange(0, 0);
    assert.equal(keyDown(textarea, 'Tab'), false);
    await settle();
    assert.equal(storedText(), '\tProject\nName');
  });

  it('Tab over a multi-line selection indents every selected line', async () => {
    seedDocument('body', 'a\nb\nc');
    const ui = render(<DocumentPanel />);
    await settle();
    const textarea = editor(ui);
    textarea.focus();
    textarea.setSelectionRange(0, 3); // "a\nb"
    assert.equal(keyDown(textarea, 'Tab'), false);
    await settle();
    assert.equal(storedText(), '\ta\n\tb\nc');
    assert.deepEqual([textarea.selectionStart, textarea.selectionEnd], [1, 5], 'the same lines stay selected');
  });

  it('the editor says how to leave the field', async () => {
    seedDocument('body');
    const ui = render(<DocumentPanel />);
    await settle();
    const textarea = editor(ui);
    const hintId = textarea.getAttribute('aria-describedby');
    assert.ok(hintId, 'the text box is described');
    const hint = ui.querySelector(`[id="${hintId}"]`);
    assert.match(hint?.textContent ?? '', /Esc.*Tab/);
  });

  it('the PDF prints each line on its own and keeps the indent; the template keeps both', async () => {
    seedDocument('subheading');
    const drawn: string[] = [];
    const seams = async (): Promise<DocumentPdfSeams> => ({
      createDoc: async () => ({
        addPage: () => {}, setFont: () => {}, setFontSize: () => {}, setTextColor: () => {},
        text: (t) => { drawn.push(t); },
        addImage: () => {}, svg: async () => {}, table: () => {},
        pageCount: () => 1,
        output: () => new Blob(['pdf']),
      }),
      renderSvg: (aggregation, w, h, theme) => renderChartSvg({ aggregation, width: w, height: h, theme, showTitle: false }),
      capture: async (ids) => new Uint8Array(ids.length),
      theme: DEFAULT_THEME,
      now: () => new Date(0),
      imageSize: async () => ({ w: 2, h: 1 }),
    });
    const downloads: string[] = [];
    const onDownload = (e: Event): void => { downloads.push(String((e as CustomEvent<{ kind: string }>).detail.kind)); };
    window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    try {
      const ui = render(<DocumentPanel pdfSeams={seams} />);
      await settle();
      const textarea = editor(ui);
      type(textarea, 'Prüfbericht\nBIM-Gesamtkoordination');
      textarea.focus();
      textarea.setSelectionRange(12, 12); // start of the second line
      keyDown(textarea, 'Tab');
      await settle();
      assert.equal(storedText(), 'Prüfbericht\n\tBIM-Gesamtkoordination');

      const button = ui.querySelector<HTMLElement>('[data-document-export]');
      assert.ok(button);
      act(() => button.click());
      for (let i = 0; i < 20 && downloads.length === 0; i++) await settle();
      assert.deepEqual(downloads, ['pdf']);
      assert.ok(drawn.includes('Prüfbericht'), drawn.join(' | '));
      const second = drawn.find((t) => t.endsWith('BIM-Gesamtkoordination'));
      assert.ok(second, drawn.join(' | '));
      assert.match(second, /^ +BIM-Gesamtkoordination$/, 'the tab prints as an indent, not as nothing and not as a raw tab');
      assert.ok(!drawn.some((t) => t.includes('\n') || t.includes('\t')), 'no raw control character reaches the PDF');
    } finally {
      window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload);
    }

    // The browser copy (what the panel reloads) and "Export template" (the same JSON `exportDocument`
    // writes) both restore the text exactly as typed.
    const saved = loadDocuments().find((d) => d.id === 'doc-6370');
    assert.equal((saved?.blocks[0] as TextBlock | undefined)?.text, 'Prüfbericht\n\tBIM-Gesamtkoordination');
    const imported = parseDocumentFile(JSON.stringify(useViewerStore.getState().documents[0], null, 2));
    assert.equal((imported.blocks[0] as TextBlock).text, 'Prüfbericht\n\tBIM-Gesamtkoordination');
  });
});
