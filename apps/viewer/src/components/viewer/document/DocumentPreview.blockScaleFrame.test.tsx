/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The preview takes the same layout decisions as the PDF composer for a scaled block (#6548): the frame a
 * block is sized against, which half-width pairs stay one row, and the height an image or a chart gets.
 * Each is read from the rendered preview and compared with what `composeDocument` lays out.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { documentPreviewReady } from '@/test/document-preview';
import { waitFor } from '@/test/render';
import { createRoot, type Root } from 'react-dom/client';
import { aggregate, type ChartSpec } from '@ifc-lite/charts';
import { DocumentPreview } from './DocumentPreview.js';
import { composeDocument, estimateTextWidth, pageFrameHeight, type ResolvedBlock } from '@/lib/document/compose.js';
import { pageBox } from '@/lib/export/report/compose.js';
import { DOCUMENT_VERSION, type ChartBlock, type DocumentBlock, type DocumentSpec } from '@/lib/document/types.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

type Page = DocumentSpec['page'];
const PORTRAIT: Page = { size: 'A4', orientation: 'portrait' };
const LANDSCAPE: Page = { size: 'A4', orientation: 'landscape' };
const chartSpec: ChartSpec = { id: 'chart', title: 'Chart', source: 'elements', type: 'bar', dimension: 'type', measure: { agg: 'count' } };
const aggregation = aggregate(chartSpec, { source: 'elements', columns: [{ id: 'type', label: 'Type', kind: 'category' }], rows: [{ ids: [1], values: ['IfcWall'] }], fingerprint: 'scale-frame' });
const BINDINGS = { models: [], activeModelId: null, today: new Date('2026-01-01') };
const SHEET_PX = 560;

async function show(page: Page, blocks: DocumentBlock[]): Promise<HTMLDivElement> {
  const document: DocumentSpec = { version: DOCUMENT_VERSION, id: 'd', name: 'Doc', page, blocks };
  const host = window.document.createElement('div');
  window.document.body.appendChild(host);
  container = host;
  root = createRoot(host);
  const aggregations = new Map(blocks.flatMap((b) => (b.kind === 'chart' ? [[b.id, aggregation] as const] : [])));
  act(() => root?.render(<DocumentPreview document={document} bindings={BINDINGS} aggregations={aggregations} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />));
  await documentPreviewReady();
  return host;
}
function unmount(): void {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

const sc = (scale: number): { scale?: number } => (scale === 1 ? {} : { scale });
const chartBlock = (id: string, patch: Partial<ChartBlock> = {}): ChartBlock => ({ kind: 'chart', id, chart: chartSpec, snapshot: false, ...patch });
const resolvedChart = (id: string, patch: Partial<Extract<ResolvedBlock, { kind: 'chart' }>> = {}): ResolvedBlock => ({ kind: 'chart', id, title: 'Chart', subtitle: '', hasData: true, snapshot: false, ...patch });
const composed = (blocks: ResolvedBlock[], page: Page) => composeDocument({ name: 'Doc', page, generatedAt: 'now', measure: estimateTextWidth, blocks });
function previewPlots(host: HTMLElement): Array<{ pageIndex: number; x: number; y: number }> {
  return Array.from(host.querySelectorAll<HTMLElement>('[data-preview-section]')).flatMap((paper, pageIndex) =>
    Array.from(paper.querySelectorAll<HTMLElement>('[data-preview-block]')).flatMap(block => {
      const plot = block.querySelector<HTMLElement>('[data-chart-svg]');
      return plot ? [{ pageIndex, x: parseFloat(block.style.left) + parseFloat(plot.style.left),
        y: parseFloat(block.style.top) + parseFloat(plot.style.top) }] : [];
    }));
}
const sameRow = (plots: Array<{ pageIndex: number; x?: number; y: number }>): boolean =>
  plots.length === 2 && plots[0].pageIndex === plots[1].pageIndex && Math.abs(plots[0].y - plots[1].y) < 1e-4;
const steps = Array.from({ length: 31 }, (_, i) => Math.round((0.5 + i * 0.05) * 100) / 100);

describe('a pair of half-width charts is one row in the preview exactly when it is in the PDF (#6548)', () => {
  const cases: Array<[string, Page, Partial<ChartBlock>]> = [
    ['clamped to the frame, portrait', PORTRAIT, { height: 600 }],
    ['clamped to the frame, with snapshots, landscape', LANDSCAPE, { height: 600, snapshot: true }],
    ['default height with snapshots, landscape', LANDSCAPE, { snapshot: true }],
  ];
  for (const [name, page, patch] of cases) {
    it(`${name}: both paths pair at every size from 0.5 to 2 in steps of 0.05`, async () => {
      const disagreements: string[] = [];
      const unpaired: number[] = [];
      for (const scale of steps) {
        const half = { width: 'half' as const, ...patch, ...sc(scale) };
        const host = await show(page, [chartBlock('a', half), chartBlock('b', half)]);
        const observed = previewPlots(host);
        const preview = sameRow(observed);
        assert.ok(observed.length === 2 && observed[1].x > observed[0].x, 'two actual plots occupy distinct columns');
        unmount();
        const asResolved = (id: string) => resolvedChart(id, { width: 'half', height: patch.height, snapshot: patch.snapshot ?? false, ...sc(scale) });
        const plots = composed([asResolved('a'), asResolved('b')], page).pages.flatMap((p, pageIndex) => p.items.flatMap((i) => (i.kind === 'chart' ? [{ pageIndex, y: i.y }] : [])));
        const pdf = sameRow(plots);
        if (preview !== pdf) disagreements.push(`${scale}: preview ${preview}, pdf ${pdf}`);
        if (!pdf) unpaired.push(scale);
      }
      assert.deepEqual(disagreements, []);
      assert.deepEqual(unpaired, [], 'a row whose height equals the frame height is a row');
    });
  }

  it('a half-width text that would outgrow the page at its size is not a pair at that size, as in the PDF', async () => {
    const long = 'abcde '.repeat(66);
    const text = (id: string, scale: number): DocumentBlock => ({ kind: 'text', id, style: 'body', text: id === 'a' ? long : 'second', width: 'half', ...(id === 'a' ? sc(scale) : {}) });
    const paired = async (scale: number): Promise<boolean> => {
      const host = await show(PORTRAIT, [text('a', scale), text('b', 1)]);
      const first = host.querySelector<HTMLElement>('[data-preview-block="a"]');
      const second = host.querySelector<HTMLElement>('[data-preview-block="b"]');
      assert.ok(first && second);
      const row = first.closest('[data-preview-section]') === second.closest('[data-preview-section]')
        && Math.abs(parseFloat(first.style.top) - parseFloat(second.style.top)) < 0.01
        && parseFloat(second.style.left) > parseFloat(first.style.left);
      unmount(); return row;
    };
    assert.equal(await paired(1), true, 'at 1x the two sit side by side');
    assert.equal(await paired(2), false, 'at 2x the first outgrows the frame its column leaves');
  });
});

describe('the height of a scaled image and chart in the preview is the PDF height (#6548)', () => {
  const image = (patch: Partial<Extract<DocumentBlock, { kind: 'image' }>>): DocumentBlock => ({ kind: 'image', id: 'image', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAABkCAIAAADITs03AAAAEUlEQVR4nGNQSFjAMIoHDQYAuKlwgXvcsCgAAAAASUVORK5CYII=', height: 600, align: 'left', ...patch });

  it('an image with no title and no caption is clamped to the frame as the PDF clamps it', async () => {
    // Before this was fixed the preview clamped only an image with a title, a caption or a page heading
    // and drew this one at 900pt where the PDF drew it at 707.9.
    for (const [page, scale] of [[PORTRAIT, 1.5], [PORTRAIT, 2], [LANDSCAPE, 1]] as const) {
      const host = await show(page, [image(sc(scale))]);
      await waitFor(() => host.querySelector<HTMLImageElement>('img')?.naturalHeight === 100, 'the valid 1 by 100 PNG actually decodes');
      await documentPreviewReady();
      const img = host.querySelector('img');
      assert.ok(img); assert.equal(img.naturalWidth, 1); assert.equal(img.naturalHeight, 100);
      const previewPt = Number.parseFloat(img.style.height) / (SHEET_PX / pageBox(page).w);
      const laid = composed([{ kind: 'image', id: 'image', height: 600, align: 'left', aspect: 0.01, ...sc(scale) }], page).pages[0].items.find((i) => i.kind === 'image');
      assert.ok(laid && laid.kind === 'image');
      const frame = pageFrameHeight(pageBox(page).h);
      assert.ok(Math.abs(previewPt - Math.min(600 * scale, frame)) < 0.01, `${page.orientation} ${scale}x: preview ${previewPt.toFixed(1)}pt against the frame ${frame.toFixed(1)}pt`);
      assert.ok(Math.abs(laid.h - Math.min(600 * scale, frame)) < 0.01, 'the composer clamps to the same height');
      unmount();
    }
  });

  it('a tall chart laid out in the frame of its size is the height the composer draws, at every size', async () => {
    for (const page of [PORTRAIT, LANDSCAPE]) for (const snapshot of [false, true]) for (const fontSize of [undefined, 24]) for (const scale of [0.5, 1, 1.5, 2]) {
      const host = await show(page, [chartBlock('c', { height: 600, snapshot, ...(fontSize ? { fontSize } : {}), ...sc(scale) })]);
      const svg = host.querySelector('[data-chart-svg] svg');
      assert.ok(svg, 'the chart renders');
      // Canonical preview places the unchanged point-space SVG in its actual composed CSS box.
      const unit = SHEET_PX / pageBox(page).w;
      const wrapper = svg.parentElement; assert.ok(wrapper);
      const previewPt = parseFloat(wrapper.style.height) / unit;
      const plot = composed([resolvedChart('c', { height: 600, snapshot, ...(fontSize ? { fontSize } : {}), ...sc(scale) })], page).pages[0].items.find((i) => i.kind === 'chart');
      assert.ok(plot && plot.kind === 'chart');
      assert.ok(Math.abs(previewPt - plot.h) < 0.01, `${page.orientation} snapshot ${snapshot} type ${fontSize ?? 'default'} ${scale}x: preview ${previewPt.toFixed(2)}pt, pdf ${plot.h.toFixed(2)}pt`);
      unmount();
    }
  });

  it('is laid out in a frame 1 / scale as tall, so a 600pt chart that fits at 1x is clamped at 1.5x', async () => {
    const at = async (scale: number): Promise<number> => { const host = await show(PORTRAIT, [chartBlock('c', { height: 600, ...sc(scale) })]); const plot = host.querySelector<HTMLElement>('[data-chart-svg]'); assert.ok(plot); const h = parseFloat(plot.style.height) / (SHEET_PX / pageBox(PORTRAIT).w); unmount(); return h; };
    const frame = pageFrameHeight(pageBox(PORTRAIT).h);
    const one = await at(1), enlarged = await at(1.5);
    assert.ok(Math.abs(one - 600) < 0.01, `at 1x the 600pt it asks for fits: ${one}`);
    assert.ok(Math.abs(enlarged - (frame / 1.5 - 32) * 1.5) < 0.01, `#6731: at 1.5x the physical composed box fills the frame below its scaled heading: ${enlarged} against ${(frame / 1.5 - 32) * 1.5}`);
  });
});
