/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocumentPreview } from './DocumentPreview.js';
import type { DocumentSpec } from '@/lib/document/types.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const imageBlock = {
  id: 'image',
  kind: 'image',
  dataUrl: 'data:image/png;base64,first',
  height: 400,
  align: 'left',
} satisfies Extract<DocumentSpec['blocks'][number], { kind: 'image' }>;

const baseDocument = {
  version: 2,
  id: 'document',
  name: 'Image preview',
  page: { size: 'A4', orientation: 'portrait' },
  blocks: [imageBlock],
} satisfies DocumentSpec;

function render(dataUrl: string): HTMLImageElement {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(
    <DocumentPreview
      document={{ ...baseDocument, blocks: [{ ...imageBlock, dataUrl }] }}
      bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }}
      aggregations={new Map()}
      topics={new Map()}
      selectedBlockId={null}
      onSelectBlock={() => {}}
    />,
 ));
  const image = container.querySelector('img');
  assert.ok(image, 'the image block renders an image element');
  return image;
}

it('resets an image preview intrinsic aspect when its data URL changes (#4983)', () => {
  const first = render('data:image/png;base64,first');
  const requestedHeight = first.style.height;
  Object.defineProperties(first, {
    naturalWidth: { configurable: true, value: 4_000 },
    naturalHeight: { configurable: true, value: 100 },
  });
  act(() => first.dispatchEvent(new Event('load', { bubbles: true })));
  assert.notEqual(first.style.height, requestedHeight, 'a very wide image clamps to the available content width');

  const second = render('data:image/png;base64,second');
  assert.notStrictEqual(second, first, 'a new data URL remounts the intrinsic-size state');
  assert.equal(second.style.height, requestedHeight, 'the old image aspect cannot constrain the replacement before it loads');
});
