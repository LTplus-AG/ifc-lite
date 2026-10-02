/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { render, cleanup, click, type as typeInput, waitFor } from '@/test/render';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { PageHeadingEditor } from './PageHeadingEditor';

afterEach(() => { cleanup(); mock.restoreAll(); });
const png = readFileSync(new URL('../../../../public/favicon-16x16-cropped.png', import.meta.url));
const spec: DocumentSpec = { version: DOCUMENT_VERSION, id: 'a', name: 'A', page: { size: 'A4', orientation: 'portrait' }, blocks: [] };

function upload(ui: HTMLElement): void {
  const input = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading logo"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array(png)], 'logo.png', { type: 'image/png' })] });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}

function holdRead() {
  const nativeRead = FileReader.prototype.readAsDataURL;
  const pending: Array<{ reader: FileReader; file: Blob }> = [];
  mock.method(FileReader.prototype, 'readAsDataURL', function (this: FileReader, file: Blob) {
    pending.push({ reader: this, file });
  });
  return { pending, release: async () => {
    assert.equal(pending.length, 1, 'the actual file reader is paused, not its result replaced');
    const { reader, file } = pending[0];
    await act(async () => {
      const done = new Promise<void>((resolve, reject) => {
        reader.addEventListener('loadend', () => resolve(), { once: true });
        reader.addEventListener('error', () => reject(reader.error), { once: true });
      });
      nativeRead.call(reader, file); await done;
    });
  } };
}

it('a delayed real PNG read keeps edits made after choosing the header logo (#6610)', async () => {
  let current = spec;
  function Editor() {
    const [document, setDocument] = useState(spec); current = document;
    return <PageHeadingEditor document={document} onChange={setDocument} />;
  }
  const held = holdRead(), ui = render(<Editor />);
  upload(ui);
  const text = ui.querySelector<HTMLInputElement>('input[aria-label="Page heading text"]'); assert.ok(text);
  typeInput(text, 'Edited while logo reads');
  await held.release();
  await waitFor(() => current.pageHeading?.logo !== undefined, 'the actual read commits its PNG');
  assert.equal(current.pageHeading?.text, 'Edited while logo reads');
  assert.equal(current.pageHeading?.logo?.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
});

it('a delayed header-logo read cannot write another document or an earlier visit to the same document (#6610)', async () => {
  let current = spec;
  function Editor() {
    const [document, setDocument] = useState(spec); current = document;
    return <><button onClick={() => setDocument({ ...spec, id: 'b', name: 'B' })}>Open B</button>
      <button onClick={() => setDocument(spec)}>Open A again</button>
      <PageHeadingEditor document={document} onChange={setDocument} /></>;
  }
  const held = holdRead(), ui = render(<Editor />);
  upload(ui);
  const buttons = [...ui.querySelectorAll('button')];
  const next = buttons.find(button => button.textContent === 'Open B'); assert.ok(next); click(next);
  const original = buttons.find(button => button.textContent === 'Open A again'); assert.ok(original); click(original);
  await held.release();
  assert.equal(current.id, 'a');
  assert.equal(current.pageHeading?.logo, undefined, 'revisiting A does not revive a cancelled earlier upload');
  assert.equal(ui.querySelector<HTMLInputElement>('input[aria-label="Page heading logo"]')?.disabled, false);
});
