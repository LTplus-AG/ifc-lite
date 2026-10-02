/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Follow-ups to the shared block heading (#6632), read from the mounted preview: the heading's size
 * follows `titleFontSize` without a jump at the default, a background changes only its colour, a long
 * heading stays on one line inside its strip, and the strip's extra height is taken out of the chart.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store/index.js';
import { cleanup, render } from '@/test/render.js';
import { documentChartSizing } from '@/lib/document/compose';
import { BLOCK_TITLE_SIZE_DEFAULT, blockTitleStyle } from '@/lib/document/block-title';
import { manualReportBlockFromChecklist } from '@/lib/document/manual-report';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec, type IdsReportBlock } from '@/lib/document/types.js';
import { CHECKLIST_VERSION } from '@/lib/validation/manual/checklist';
import { DocumentPanel } from './DocumentPanel.js';

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const POINT_SCALE = 560 / A4_WIDTH;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const LONG = 'Fire door in corridor 2.14 is missing its closer and label';

const ids = (id: string, sourceKind: 'ids' | 'rules'): IdsReportBlock => ({ kind: 'ids-report', id, sourceKind, variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 4, passed: 1, failed: 3, passRate: 25 },
  checks: [{ id: 's1', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }] });
const manual = manualReportBlockFromChecklist({ checklist: { version: CHECKLIST_VERSION, name: 'Checklist source', groups: [{ id: 'g', name: 'Review', items: [{ id: 'a', text: 'Check' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, now: new Date(0) }, 'manual-report');
/** Every kind with a heading; the table and report blocks carry the fixed id the preview selects them by. */
const IDS_OF_KIND = ['text', 'image', 'chart', 'topic', 'table', 'ids', 'rules', 'manual-report'] as const;
const blocks = (style: Record<string, unknown>, title: (id: string) => string = (id) => `H:${id}`): DocumentBlock[] => [
  { kind: 'text', id: 'text', style: 'body', text: 'Body text', title: title('text'), ...style },
  { kind: 'image', id: 'image', dataUrl: PNG, height: 40, align: 'left', title: title('image'), ...style },
  { kind: 'chart', id: 'chart', chart: { id: 'c', title: 'Chart source', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, height: 120, title: title('chart'), ...style },
  { kind: 'topic', id: 'topic', guid: 'topic-guid', snapshot: false, title: title('topic'), ...style },
  { kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: title('table'), ...style },
  { ...ids('ids', 'ids'), title: title('ids'), ...style },
  { ...ids('rules', 'rules'), title: title('rules'), ...style },
  { ...manual, title: title('manual-report'), ...style },
] as DocumentBlock[];

const mount = async (document: DocumentSpec): Promise<HTMLElement> => {
  useViewerStore.setState({ documents: [document], activeDocumentId: document.id });
  const ui = render(<DocumentPanel />);
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  return ui;
};
const spec = (blockList: DocumentBlock[], orientation: 'portrait' | 'landscape' = 'portrait'): DocumentSpec =>
  ({ version: DOCUMENT_VERSION, id: 'doc-heading-follow-ups', name: 'Headings', page: { size: 'A4', orientation }, blocks: blockList });
/** The element a preview block renders its heading in: the smallest element whose own text is exactly the heading. */
function headingOf(ui: HTMLElement, blockId: string, text: string): HTMLElement {
  const found = [...ui.querySelectorAll<HTMLElement>(`[data-preview-block="${blockId}"] *`)].find((el) => el.children.length === 0 && el.textContent === text);
  assert.ok(found, `${blockId}: the preview renders the heading "${text}"`);
  return found;
}
const measure = (heading: HTMLElement) => { const style = window.getComputedStyle(heading); return { size: Number.parseFloat(style.fontSize), height: Number.parseFloat(style.height) }; };

beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({ models: new Map(), activeModelId: null, documents: [], activeDocumentId: null, dashboards: [], selectedEntityIds: new Set(),
    mutationViews: new Map(), mutationVersion: 0, idsValidationReport: null, validationSource: null, savedValidationReports: [], validationReportsLoadIssue: null,
    bcfProject: { version: '3.0', topics: new Map([['topic-guid', { guid: 'topic-guid', title: LONG, description: 'Coordinate', viewpoints: [], comments: [] }]]) } });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('the preview heading follows its size without a jump at the default (#6632 follow-up)', () => {
  const sizeOf = async (style: Record<string, unknown>) => {
    const ui = await mount(spec(blocks(style)));
    const out = new Map<string, { size: number; height: number }>();
    for (const id of IDS_OF_KIND) out.set(id, measure(headingOf(ui, id, `H:${id}`)));
    cleanup();
    return out;
  };
  it('an unset size and an explicit default are the same heading, in the PDF\'s 11pt, on every kind', async () => {
    const unset = await sizeOf({});
    const explicit = await sizeOf({ titleFontSize: BLOCK_TITLE_SIZE_DEFAULT });
    for (const id of IDS_OF_KIND) {
      assert.ok(Math.abs(unset.get(id)!.size - BLOCK_TITLE_SIZE_DEFAULT * POINT_SCALE) < 1e-3, `${id}: unset heading is ${unset.get(id)!.size}px, not 11pt at the sheet scale ${BLOCK_TITLE_SIZE_DEFAULT * POINT_SCALE}px`);
      assert.deepEqual(explicit.get(id), unset.get(id), `${id}: an explicit default changes nothing`);
    }
  });
  it('only a background set changes neither the size nor the height, so the content below does not move', async () => {
    const unset = await sizeOf({});
    const filled = await sizeOf({ titleBackgroundColor: '#ffff00' });
    for (const id of IDS_OF_KIND) assert.deepEqual(filled.get(id), unset.get(id), `${id}: a background alone keeps the heading's size and strip`);
  });
  it('raising the size never shrinks the heading: it grows with every step from 6 to 24', async () => {
    const steps = [6, 8, 11, 12, 14, 18, 24];
    const measured: Array<Map<string, { size: number; height: number }>> = [];
    for (const titleFontSize of steps) measured.push(await sizeOf({ titleFontSize }));
    for (const id of IDS_OF_KIND) {
      const sizes: number[] = measured.map((m) => m.get(id)!.size);
      const heights: number[] = measured.map((m) => m.get(id)!.height);
      for (let i = 1; i < steps.length; i++) {
        assert.ok(sizes[i] > sizes[i - 1], `${id}: size ${steps[i]} draws ${sizes[i]}px, not larger than size ${steps[i - 1]}'s ${sizes[i - 1]}px`);
        assert.ok(heights[i] >= heights[i - 1] - 1e-6, `${id}: the strip does not shrink from size ${steps[i - 1]} to ${steps[i]}`);
      }
    }
  });
});

describe('a long preview heading stays on one line inside its strip (#6632 follow-up)', () => {
  it('every kind, at the largest size, cuts the heading instead of wrapping it over the content below', async () => {
    const ui = await mount(spec(blocks({ titleFontSize: 24, titleBackgroundColor: '#ffff00' }, (id) => `H:${id} ${LONG}`)));
    for (const id of IDS_OF_KIND) {
      const heading = headingOf(ui, id, `H:${id} ${LONG}`);
      const style = window.getComputedStyle(heading);
      assert.equal(style.whiteSpace, 'nowrap', `${id}: the heading does not wrap`);
      assert.equal(style.overflow, 'hidden', `${id}: what does not fit is cut at the strip, not drawn over the content`);
      assert.equal(style.textOverflow, 'ellipsis', `${id}: the cut shows an ellipsis, like the PDF`);
    }
  });
  it('a topic with no authored title, at the largest size, cuts the topic\'s own title, and so does the not-loaded notice', async () => {
    const ui = await mount(spec([
      { kind: 'topic', id: 'loaded', guid: 'topic-guid', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00' },
      { kind: 'topic', id: 'missing', guid: 'no-such-topic', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00', title: LONG },
    ] as DocumentBlock[]));
    const loaded = window.getComputedStyle(headingOf(ui, 'loaded', LONG));
    assert.equal(loaded.whiteSpace, 'nowrap', 'the topic\'s own title does not wrap over the lines below it');
    assert.equal(loaded.overflow, 'hidden');
    assert.equal(window.getComputedStyle(headingOf(ui, 'missing', LONG)).whiteSpace, 'nowrap', 'the heading above the not-loaded notice does not wrap');
  });
});

describe('the title controls cannot be mistaken for the table\'s column-header controls (#6632 follow-up)', () => {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) { const above = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)); diagonal = above; }
    }
    return row[b.length];
  };
  it('the table editor names each of its colour controls with a first word at least four edits from the other group\'s', async () => {
    const ui = await mount(spec(blocks({}).filter((b) => b.kind === 'table')));
    const editor = ui.querySelector<HTMLElement>('[data-block-kind="table"]');
    assert.ok(editor, 'the table has an editor');
    const labels = [...editor.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '');
    assert.equal(new Set(labels).size, labels.length, 'no two controls of the table editor share an accessible name');
    const title = [...editor.querySelectorAll('[data-block-title-editor] [aria-label]')].map((el) => el.getAttribute('aria-label') ?? '').filter((label) => !/ title$/i.test(label));
    const header = labels.filter((label) => /^(Header|Reset table header)/i.test(label));
    assert.ok(title.length === 5 && header.length === 4, `the editor has the title controls (${title.join(', ')}) and the column-header controls (${header.join(', ')})`);
    for (const t of title) for (const h of header) assert.ok(distance(t.split(' ')[0].toLowerCase(), h.split(' ')[0].toLowerCase()) >= 4 || t.split(' ')[0] === 'Reset', `"${t}" is too close to "${h}"`);
  });
});

describe('the heading strip\'s extra height is taken out of the preview chart (#6632 follow-up)', () => {
  it('a chart as tall as the page allows is shorter by exactly the height an enlarged heading adds', async () => {
    const heightOf = async (style: Record<string, unknown>) => {
      const ui = await mount(spec([{ kind: 'chart', id: 'chart', chart: { id: 'c', title: 'Chart source', source: 'elements', type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, height: 600, title: 'H:chart', ...style }] as DocumentBlock[], 'landscape'));
      const empty = ui.querySelector<HTMLElement>('[data-document-preview] [data-chart-empty]');
      assert.ok(empty, 'the chart has no data, so the preview draws its placeholder at the chart\'s height');
      const height = Number.parseFloat(empty.style.height);
      cleanup();
      return height;
    };
    const plain = await heightOf({});
    const enlarged = await heightOf({ titleFontSize: 24 });
    const pointScale = 560 / A4_HEIGHT;
    const expectedPlain = documentChartSizing({ requestedHeight: 600, headingExtraHeight: 0, pageHeight: A4_WIDTH, boxWidth: 500, snapshot: false, hasData: false }).height * pointScale;
    assert.ok(Math.abs(plain - expectedPlain) < 1e-3, `the plain chart is the page-limited ${expectedPlain}px, not ${plain}px: the probe reaches the clamp`);
    assert.ok(Math.abs((plain - enlarged) - blockTitleStyle({ titleFontSize: 24 }).extra * pointScale) < 1e-3, `the enlarged heading takes ${plain - enlarged}px out of the chart`);
  });
});
