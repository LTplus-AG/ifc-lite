/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { activate, click, waitFor } from '@/test/render.js';
import { aggregate } from '@ifc-lite/charts';
import { DocumentPreview } from './DocumentPreview.js';
import { TEXT_STYLES } from '@/lib/document/compose.js';
import { pageBox } from '@/lib/export/report/compose.js';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types.js';
import { dataUrlToBytes } from '@/lib/export/download';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const ready = () => waitFor(() => !!container?.querySelector('[data-preview-section]')
  && container.querySelector('[data-layout-pending="true"]') === null, 'shared document layout ready');

function assertAspectRatio(frame: HTMLElement, ratio: number, message: string): void {
  const w = Number.parseFloat(frame.style.width), h = Number.parseFloat(frame.style.height);
  assert.ok(w > 0 && h > 0, 'the composed frame has positive dimensions');
  // CSS serialization rounds the point-to-pixel result. One hundredth of a
  // CSS pixel retains the physical invariant without requiring float identity.
  assert.ok(Math.abs(h - w / ratio) < 0.01, `${message}: ${w} by ${h}`);
}

// Distinct real committed PNGs survive automatic decoding and remain portable.
// Each size-event invariant below still supplies its stated natural dimensions.
const imageAssets = { first: 16, second: 32, old: 48, replacement: 64, next: 96 } as const;
const imageDataUrl = (name: keyof typeof imageAssets) => {
  const icon = readFileSync(new URL(`../../../../public/favicon-${imageAssets[name]}x${imageAssets[name]}-cropped.png`, import.meta.url));
  const url = `data:image/png;base64,${icon.toString('base64')}`;
  const bytes = dataUrlToBytes(url);
  assert.ok(bytes, 'the positive fixture is accepted by the actual PDF asset decoder');
  assert.deepEqual(Buffer.from(bytes), icon, 'the URI decodes to its committed PNG asset');
  return url;
};

const imageBlock = {
  id: 'image',
  kind: 'image',
  dataUrl: imageDataUrl('first'),
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

it('keeps a failed BCF snapshot at the canonical PDF fallback proportion (#6610)', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const topic = { guid: 'broken-snapshot', title: 'Coordination image', comments: [],
    viewpoints: [{ guid: 'viewpoint', snapshot: 'data:image/png;base64,invalid' }] };
  const doc: DocumentSpec = { ...baseDocument, blocks: [{ kind: 'topic', id: 'topic', guid: topic.guid, snapshot: true }] };
  act(() => root?.render(<DocumentPreview document={doc}
    bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }}
    aggregations={new Map()} chartMessages={new Map()} topics={new Map([[topic.guid, topic]])}
    selectedBlockId={null} onSelectBlock={() => {}} />));
  await ready();
  const image = container.querySelector('[data-preview-block="topic"] img');
  // The real initial zero-size load may already have settled this bad asset.
  if (image) act(() => image.dispatchEvent(new Event('error', { bubbles: true })));
  await ready();
  const placeholder = container.querySelector<HTMLElement>('[data-preview-block="topic"] .border-dashed'); assert.ok(placeholder);
  // A missing/undecodable BCF snapshot uses the existing resolver's 4:3 PDF
  // fallback, whereas an ordinary image uses its independent square fallback.
  assertAspectRatio(placeholder, 4 / 3, 'preview fallback must match the PDF frame');
  assert.equal(container.querySelector('[data-document-preview]')?.getAttribute('aria-busy'), 'false');
});

it('#5823 selects the same document block by click, Enter, and Space', async () => {
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
  await ready();
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

async function render(dataUrl: string): Promise<HTMLImageElement> {
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
  await ready();
  const image = container.querySelector('img');
  assert.ok(image, 'the image block renders an image element');
  return image;
}

it('resets an image preview intrinsic aspect when its data URL changes (#4983)', async () => {
  const first = await render(imageDataUrl('first'));
  const requestedHeight = first.style.height;
  Object.defineProperties(first, {
    naturalWidth: { configurable: true, value: 4_000 },
    naturalHeight: { configurable: true, value: 100 },
  });
  act(() => first.dispatchEvent(new Event('load', { bubbles: true })));
  await ready();
  const resized = container?.querySelector('img');
  assert.ok(resized);
  assert.notEqual(resized.style.height, requestedHeight, 'a very wide image clamps to the available content width');

  const second = await render(imageDataUrl('second'));
  assert.notStrictEqual(second, first, 'a new data URL remounts the intrinsic-size state');
  assert.equal(second.style.height, requestedHeight, 'the old image aspect cannot constrain the replacement before it loads');
});

it('puts half-width text next to a logo and applies its PDF font controls (#4940)', async () => {
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
  await ready();
  const left = container.querySelector<HTMLElement>('[data-preview-block="heading"]');
  const right = container.querySelector<HTMLElement>('[data-preview-block="image"]');
  assert.ok(left && right);
  assert.ok(parseFloat(right.style.left) > parseFloat(left.style.left) + parseFloat(left.style.width), 'logo and heading occupy separate canonical columns');
  const text = left.querySelector<HTMLElement>('[data-block-text]');
  assert.ok(text);
  assert.match(text.style.fontFamily, /Times New Roman/);
  assert.ok(Number.parseFloat(text.style.fontSize) > 14);
});

it('previews an overlong half-width text block as paginated full-width content (#4940)', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, blocks: [
    { kind: 'text', id: 'long', style: 'body', text: 'A long report paragraph. '.repeat(900), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  await ready();
  const papers = [...container.querySelectorAll('[data-preview-section]')];
  assert.ok(papers.length > 1, 'long text has actual continuation pages');
  assert.ok(papers.slice(0, -1).every(page => page.querySelector('[data-preview-block="long"]') && !page.querySelector('[data-preview-block="image"]')), 'the image cannot be paired through the overflowing paragraph');
  assert.ok(papers.at(-1)?.querySelector('[data-preview-block="image"]'));
});

it('uses a wide-glyph bound when pairing text with a logo (#4940 review)', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, blocks: [
    { kind: 'text', id: 'wide', style: 'body', text: Array(34).fill('W'.repeat(30)).join('\n'), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  await ready();
  const text = container.querySelector<HTMLElement>('[data-preview-block="wide"]');
  const image = container.querySelector<HTMLElement>('[data-preview-block="image"]');
  assert.ok(text && image);
  assert.ok(image.parentElement !== text.parentElement || parseFloat(image.style.top) > parseFloat(text.style.top) + parseFloat(text.style.height), 'wide glyphs fall back to full-width flow');
});

it('uses the PDF column gap for A3 boundary-width text and its logo (#4940 review)', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const doc: DocumentSpec = { ...baseDocument, page: { size: 'A3', orientation: 'portrait' }, blocks: [
    { kind: 'text', id: 'boundary', style: 'body', fontSize: 10.1, text: Array(74).fill('W'.repeat(37)).join('\n'), width: 'half' },
    { ...imageBlock, width: 'half' },
  ] };
  act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  await ready();
  const image = container.querySelector<HTMLElement>('[data-preview-block="image"]');
  assert.ok(image);
  const size = pageBox(doc.page);
  const expectedX = 40 + (size.w - 80 - 10) / 2 + 10;
  assert.ok(Math.abs(parseFloat(image.style.left) - expectedX * 560 / size.w) < 0.001, 'the PDF column origin includes its exact 10pt gap');
});

it('clamps a tall chart to the same printable-page height as PDF composition (#4983 review)', async () => {
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

  await ready();
  const svg = container.querySelector('[data-chart-svg] svg');
  assert.ok(svg, 'the populated chart renders an SVG');
  const size = pageBox(page);
  const scale = 560 / size.w;
  // Independent page-frame invariant: 40pt margins, 30pt header, 24pt footer,
  // and the 32pt chart title/subtitle strip. Landscape is wide enough for the snapshot
  // to sit beside the chart, so it consumes no additional vertical space.
  const expected = (size.h - 40 - 30 - 40 - 24 - 32) * scale;
  const chartBox = svg.parentElement;
  assert.ok(chartBox);
  assert.ok(Math.abs(Number.parseFloat(chartBox.style.height) - expected) < 0.01, `preview SVG height ${svg.getAttribute('height')} matches the PDF clamp ${expected}`);
});


it('keeps a replacement-image decode failure settled and ignores late old-image events (#6610)', async () => {
  const old = await render(imageDataUrl('old'));
  const replacement = await render(imageDataUrl('replacement'));
  act(() => replacement.dispatchEvent(new Event('error')));
  await ready();
  assert.equal(container?.querySelector('[data-document-preview]')?.getAttribute('aria-busy'), 'false', 'failed decoding does not leave pagination permanently pending');
  assert.match(container?.textContent ?? '', /The image could not be decoded/);
  const placeholder = container?.querySelector<HTMLElement>('[data-preview-block="image"] .border-dashed'); assert.ok(placeholder);
  assertAspectRatio(placeholder, 1, 'ordinary image decode failures retain their square fallback');
  assert.match(container?.querySelector('[data-page-counter]')?.textContent ?? '', /Page 1 \/ 1/);
  act(() => { old.dispatchEvent(new Event('error')); old.dispatchEvent(new Event('load')); });
  await ready();
  assert.match(container?.textContent ?? '', /The image could not be decoded/, 'late callbacks cannot revive or clear the replacement failure');
  const next = await render(imageDataUrl('next'));
  Object.defineProperties(next, { naturalWidth: { configurable: true, value: 40 }, naturalHeight: { configurable: true, value: 20 } });
  act(() => next.dispatchEvent(new Event('load')));
  await ready();
  assert.equal(container?.querySelector('[data-document-preview]')?.getAttribute('aria-busy'), 'false');
  assert.doesNotMatch(container?.textContent ?? '', /The image could not be decoded/, 'a valid replacement clears the removed asset failure');
  const decoded = container?.querySelector<HTMLElement>('[data-preview-block="image"] img'); assert.ok(decoded);
  assertAspectRatio(decoded, 2, 'a successfully decoded replacement retains its actual natural proportions');
});

it('keeps blank text and missing topics accessible and selectable without changing their composed ink (#6610)', async () => {
  const selections: string[] = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root?.render(<DocumentPreview document={{ ...baseDocument, blocks: [
    { kind: 'text', id: 'empty', text: '', style: 'body' },
    { kind: 'topic', id: 'missing', guid: 'deleted-topic', snapshot: false },
  ] }} bindings={{ models: [], activeModelId: null, today: new Date(0) }} aggregations={new Map()}
    chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={id => selections.push(id)} />));
  await ready();
  const empty = container.querySelector('[data-preview-block="empty"]'); assert.ok(empty); assert.match(empty.textContent ?? '', /\(empty\)/);
  const missing = container.querySelector<HTMLElement>('[data-preview-block="missing"][data-unresolved]'); assert.ok(missing);
  assert.match(missing.textContent ?? '', /BCF topic deleted-topic: not among the loaded topics/);
  click(empty); activate(missing, 'Enter'); assert.deepEqual(selections, ['empty', 'missing']);
});

// #6548: CSS line boxes must use the same pitch as the compositor's half-page fit calculation.
it('keeps scaled preview text line pitch consistent with PDF layout (#6548)', async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const styles = Object.keys(TEXT_STYLES) as Array<keyof typeof TEXT_STYLES>;
  for (const factor of [0.5, 1, 2]) {
    const doc: DocumentSpec = { ...baseDocument, blocks: styles.map((style) => ({
      kind: 'text', id: style, style, text: 'First line\nSecond line', scale: factor,
    })) };
    act(() => root?.render(<DocumentPreview document={doc} bindings={{ models: [], activeModelId: null, today: new Date('2026-01-01') }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
    await ready();
    const pageScale = 560 / pageBox(doc.page).w;
    for (const style of styles) {
      const text: HTMLElement | null = container.querySelector<HTMLElement>(`[data-preview-block="${style}"] [data-block-text]`);
      assert.ok(text);
      assert.equal(Number(window.getComputedStyle(text).lineHeight), TEXT_STYLES[style].lineHeight, `${style} at ${factor}x uses the PDF line-height multiplier`);
      const glyphs: HTMLElement[] = Array.from(text.querySelectorAll<HTMLElement>('span'));
      const first: HTMLElement | undefined = glyphs.find(node => node.textContent?.trim() === 'First line');
      const second: HTMLElement | undefined = glyphs.find(node => node.textContent?.trim() === 'Second line'); assert.ok(first && second);
      const pitch = parseFloat(second.style.top) - parseFloat(first.style.top);
      const expected = TEXT_STYLES[style].size * TEXT_STYLES[style].lineHeight * factor * pageScale;
      assert.ok(Math.abs(pitch - expected) < 0.01, `${style} at ${factor}x has the measured PDF line pitch`);
    }
  }
});
