/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { resolveEnglish } from '@/i18n/registry';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { render, cleanup, click, waitFor, advance } from '@/test/render';
import { act } from 'react';
import { DocumentPreview } from './DocumentPreview';

afterEach(cleanup);
const bindings = { models: [], activeModelId: null, today: new Date('2026-10-02T12:00:00Z') };
const aggregations = new Map();
const messages = new Map<string, string>();
const topics = new Map();
const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'lifecycle', name: 'Current inspection',
  page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'text', id: 'evidence', style: 'body',
    text: Array.from({ length: 100 }, (_, index) => `Inspection evidence ${index + 1}`).join('\n') }] };

function Editable({ image = false }: { image?: boolean }) {
  const [spec, setSpec] = useState<DocumentSpec>(() => image ? { ...document, blocks: [{ kind: 'image', id: 'image',
    dataUrl: 'data:image/png;base64,pending-asset', height: 120, align: 'left' }, ...document.blocks] } : document);
  const [failing, setFailing] = useState(false);
  return <>
    <button onClick={() => setSpec(previous => ({ ...previous, blocks: previous.blocks.map(block => block.kind === 'text'
      ? { ...block, fontSize: 24 } : block) }))}>Enlarge evidence</button>
    <button onClick={() => setSpec({ ...document, id: 'replacement', name: 'Replacement inspection', blocks: [
      { kind: 'text', id: 'replacement-body', style: 'body', text: 'Replacement evidence' }] })}>Replace document</button>
    <button onClick={() => setFailing(true)}>Reject label preparation</button>
    <DocumentPreview document={spec} bindings={bindings} aggregations={aggregations} chartMessages={messages}
      topics={topics} selectedBlockId={null} onSelectBlock={() => {}} labels={failing ? (key, params) => {
        // A captured label dependency can fail during asynchronous composition;
        // the invariant concerns its real rejection lifecycle, not its text.
        if (key === 'document.print.footer') throw new Error('Captured label preparation failed');
        return resolveEnglish(key, params);
      } : resolveEnglish} />
  </>;
}

async function ready(ui: HTMLElement) {
  await waitFor(() => ui.querySelector('[data-preview-section]') !== null, 'actual shared layout is prepared');
}

it('settles a zero-natural-size load through the existing decode failure fallback (#6660 review)', async () => {
  const ui = render(<Editable image />); await ready(ui);
  const image = ui.querySelector<HTMLImageElement>('[data-preview-block="image"] img'); assert.ok(image);
  Object.defineProperties(image, { naturalWidth: { configurable: true, value: 0 }, naturalHeight: { configurable: true, value: 0 } });
  act(() => image.dispatchEvent(new Event('load')));
  await advance(0);
  assert.equal(ui.querySelector('[data-document-preview]')?.getAttribute('aria-busy'), 'false', 'zero-size load must settle rather than remain pending');
  assert.match(ui.textContent ?? '', /The image could not be decoded/);
  const fallback = ui.querySelector<HTMLElement>('[data-preview-block="image"] .border-dashed'); assert.ok(fallback);
  assert.ok(Math.abs(parseFloat(fallback.style.height) - parseFloat(fallback.style.width)) < 0.01, 'ordinary decode failure keeps the shared square fallback');
});

it('keeps all prepared sheets mounted during same-document reflow, then commits truthful new pages (#6660 review)', async () => {
  const ui = render(<Editable />); await ready(ui);
  const first = ui.querySelector('[data-preview-section]'); assert.ok(first);
  const before = ui.querySelectorAll('[data-preview-section]').length; assert.equal(before, 2);
  ui.scrollTop = 500;
  const enlarge = ui.querySelector('button'); assert.ok(enlarge); click(enlarge);
  assert.equal(ui.querySelectorAll('[data-preview-section]').length, before, 'pending layout must not collapse two sheets to a placeholder');
  assert.equal(ui.querySelector('[data-preview-section]'), first, 'the existing sheet DOM survives asynchronous measurement');
  assert.equal(ui.scrollTop, 500);
  assert.equal(ui.querySelector('[data-document-preview]')?.getAttribute('aria-busy'), 'true');
  await waitFor(() => ui.querySelectorAll('[data-preview-section]').length > before
    && ui.querySelector('[data-document-preview]')?.getAttribute('aria-busy') === 'false', 'larger actual standard-font lines commit more pages');
  const pages = ui.querySelectorAll('[data-preview-section]');
  assert.match(pages[pages.length - 1].textContent ?? '', /Inspection evidence 100/);
  assert.equal(ui.querySelector('[data-preview-section]'), first);
});

it('does not retain another document while replacement prepares (#6660 review)', async () => {
  const ui = render(<Editable />); await ready(ui);
  const replace = Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Replace document'); assert.ok(replace);
  click(replace);
  assert.equal(ui.querySelector('[data-preview-section]'), null, 'a different document gets the initial pending paper');
  assert.doesNotMatch(ui.textContent ?? '', /Inspection evidence 100/);
  await ready(ui);
  assert.equal(ui.querySelectorAll('[data-preview-section]').length, 1);
  assert.match(ui.textContent ?? '', /Replacement evidence/);
  assert.doesNotMatch(ui.textContent ?? '', /Current inspection/);
});

it('replaces retained content with an actionable asynchronous composition error (#6660 review)', async () => {
  const ui = render(<Editable />); await ready(ui);
  const reject = Array.from(ui.querySelectorAll('button')).find(button => button.textContent === 'Reject label preparation'); assert.ok(reject);
  click(reject);
  await waitFor(() => ui.querySelector('[role="alert"]') !== null, 'the real failed composition is reported');
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /Captured label preparation failed/);
  assert.equal(ui.querySelector('[data-preview-section]'), null, 'failed preparation cannot leave stale content looking current');
});
