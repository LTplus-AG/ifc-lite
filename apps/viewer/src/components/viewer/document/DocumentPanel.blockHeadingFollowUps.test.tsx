/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Follow-ups to the shared block heading (#6632, #6705), read from the mounted panel: a topic heading
 * is cut to its column in the preview, the title controls are named apart from the table's header
 * controls, and the strip's extra height is taken out of the chart.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store/index.js';
import { cleanup, render } from '@/test/render.js';
import { documentChartSizing } from '@/lib/document/compose';
import { blockTitleStyle } from '@/lib/document/block-title';
import { DOCUMENT_VERSION, type DocumentBlock, type DocumentSpec } from '@/lib/document/types.js';
import { DocumentPanel } from './DocumentPanel.js';

const A4_HEIGHT = 841.89;
const A4_WIDTH = 595.28;
const LONG = 'Fire door in corridor 2.14 is missing its closer and label';
const TABLE: DocumentBlock = { kind: 'table', id: 'table', source: { kind: 'validation', rows: 'failed', columns: ['rule'] }, title: 'H:table' };

const mount = async (document: DocumentSpec): Promise<HTMLElement> => {
  useViewerStore.setState({ documents: [document], activeDocumentId: document.id });
  const ui = render(<DocumentPanel />);
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  return ui;
};
const spec = (blockList: DocumentBlock[], orientation: 'portrait' | 'landscape' = 'portrait'): DocumentSpec =>
  ({ version: DOCUMENT_VERSION, id: 'doc-heading-follow-ups', name: 'Headings', page: { size: 'A4', orientation }, blocks: blockList });
beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({ models: new Map(), activeModelId: null, documents: [], activeDocumentId: null, dashboards: [], selectedEntityIds: new Set(),
    mutationViews: new Map(), mutationVersion: 0, idsValidationReport: null, validationSource: null, savedValidationReports: [], validationReportsLoadIssue: null,
    bcfProject: { version: '3.0', topics: new Map([['topic-guid', { guid: 'topic-guid', title: LONG, description: 'Coordinate', viewpoints: [], comments: [] }]]) } });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('a topic heading in the preview is cut to its column like the PDF\'s (#6705)', () => {
  // The preview draws the composer's items (#6731), so the heading it shows is the one `compose.ts` cut.
  const headingText = (ui: HTMLElement, blockId: string): string => {
    const spans = [...ui.querySelectorAll<HTMLElement>(`[data-preview-block="${blockId}"] span`)].filter((el) => el.style.fontWeight === '700');
    assert.equal(spans.length, 1, `${blockId}: the preview draws one bold heading`);
    return (spans[0].textContent ?? '').trimEnd();
  };
  it('a topic with no authored title, at the largest size, cuts the topic\'s own title, and so does the not-loaded notice', async () => {
    const ui = await mount(spec([
      { kind: 'topic', id: 'loaded', guid: 'topic-guid', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00' },
      { kind: 'topic', id: 'missing', guid: 'no-such-topic-in-the-loaded-project', snapshot: false, titleFontSize: 24, titleBackgroundColor: '#ffff00' },
    ] as DocumentBlock[]));
    const loaded = headingText(ui, 'loaded');
    assert.ok(loaded.endsWith('…') && LONG.startsWith(loaded.slice(0, -1)), `the topic's own title is cut with an ellipsis, not drawn whole past the strip: "${loaded}"`);
    const missing = headingText(ui, 'missing');
    assert.ok(missing.endsWith('…') && missing.includes('no-such-topic'), `the not-loaded notice is cut with an ellipsis: "${missing}"`);
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
    const ui = await mount(spec([TABLE]));
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
