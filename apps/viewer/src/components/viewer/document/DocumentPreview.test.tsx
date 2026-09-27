/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { activate, click } from '@/test/render.js';
import { aggregate } from '@ifc-lite/charts';
import { DocumentPreview } from './DocumentPreview.js';
import { pageBox } from '@/lib/export/report/compose.js';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types.js';

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
  version: DOCUMENT_VERSION,
  id: 'document',
  name: 'Image preview',
  page: { size: 'A4', orientation: 'portrait' },
  blocks: [imageBlock],
} satisfies DocumentSpec;

it('#5823 selects the same document block by click, Enter, and Space', () => {
  const selections: string[] = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(
    <DocumentPreview
      document={{ ...baseDocument, blocks: [imageBlock, { kind: 'spacer', id: 'spacer', height: 12 }] }}
      bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }}
      aggregations={new Map()}
      chartMessages={new Map()}
      topics={new Map()}
      selectedBlockId={null}
      onSelectBlock={(id) => selections.push(id)}
    />,
  ));
  const block = container.querySelector<HTMLElement>('[data-preview-block="image"]');
  assert.ok(block);
  assert.equal(block.getAttribute('role'), 'button');
  assert.equal(block.getAttribute('aria-label'), 'Image / logo');
  assert.equal(container.querySelector('[data-preview-block="spacer"]')?.getAttribute('aria-label'), 'Spacer');
  click(block);
  activate(block, 'Enter');
  activate(block, ' ');
  assert.deepEqual(selections, ['image', 'image', 'image']);
});

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
      chartMessages={new Map()}
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

it('puts half-width text next to a logo and applies its PDF font controls (#4940)', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = {
    ...baseDocument,
    blocks: [
      { kind: 'text', id: 'heading', style: 'heading', text: 'Prüfbericht', width: 'half', font: 'times', fontSize: 16 },
      { ...imageBlock, width: 'half' },
    ],
  };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  const row = container.querySelector('[data-preview-row]');
  assert.ok(row);
  assert.equal(row.querySelectorAll('[data-preview-block]').length, 2);
  const text = row.querySelector<HTMLElement>('[data-block-text]');
  assert.ok(text);
  assert.match(text.style.fontFamily, /Times New Roman/);
  assert.ok(Number.parseFloat(text.style.fontSize) > 14);
});

it('previews an overlong half-width text block as paginated full-width content (#4940)', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, blocks: [
    { kind: 'text', id: 'long', style: 'body', text: 'A long report paragraph. '.repeat(900), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  assert.equal(container.querySelectorAll('[data-preview-row]').length, 0);
  assert.equal(container.querySelectorAll('[data-preview-block]').length, 2);
});

it('uses a wide-glyph bound when pairing text with a logo (#4940 review)', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, blocks: [
    { kind: 'text', id: 'wide', style: 'body', text: Array(34).fill('W'.repeat(30)).join('\n'), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  assert.equal(container.querySelectorAll('[data-preview-row]').length, 0);
});

it('uses the PDF column gap for A3 boundary-width text and its logo (#4940 review)', () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, page: { size: 'A3', orientation: 'portrait' }, blocks: [
    { kind: 'text', id: 'boundary', style: 'body', fontSize: 10.1, text: Array(74).fill('W'.repeat(37)).join('\n'), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  const row = container.querySelector<HTMLElement>('[data-preview-row]');
  assert.ok(row);
  assert.ok(Math.abs(Number.parseFloat(row.style.gap) - 10 * 560 / pageBox(doc.page).w) < 0.001);
});

it('clamps a tall chart to the same printable-page height as PDF composition (#4983 review)', () => {
  const chart = { id: 'chart', title: 'Tall chart', source: 'elements', type: 'bar', dimension: 'type', measure: { agg: 'count' } } as const;
  const aggregation = aggregate(chart, {
    source: 'elements',
    columns: [{ id: 'type', label: 'Type', kind: 'category' }],
    rows: [{ ids: [1], values: ['IfcWall'] }],
    fingerprint: 'preview-height',
  });
  const page = { size: 'A4', orientation: 'landscape' } as const;
  const document: DocumentSpec = {
    version: DOCUMENT_VERSION,
    id: 'chart-document',
    name: 'Chart preview',
    page,
    blocks: [{ id: 'chart-block', kind: 'chart', chart, snapshot: true, height: 600 }],
  };
  container = window.document.createElement('div');
  window.document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(
    <DocumentPreview document={document} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map([['chart-block', aggregation]])} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />,
  ));

  const svg = container.querySelector('[data-chart-svg] svg');
  assert.ok(svg, 'the populated chart renders an SVG');
  const size = pageBox(page);
  const scale = 560 / size.w;
  // Independent page-frame invariant: 40pt margins, 30pt header, 24pt footer,
  // and the 32pt chart title/subtitle strip. Landscape is wide enough for the snapshot
  // to sit beside the chart, so it consumes no additional vertical space.
  const expected = (size.h - 40 - 30 - 40 - 24 - 32) * scale;
  assert.ok(Math.abs(Number(svg.getAttribute('height')) - expected) < 0.01, `preview SVG height ${svg.getAttribute('height')} matches the PDF clamp ${expected}`);
});
