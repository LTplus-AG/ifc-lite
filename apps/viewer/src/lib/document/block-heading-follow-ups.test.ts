/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Follow-ups to the shared block heading (#6632): a heading whose size or strip can be changed is drawn
 * inside its strip and inside the printable frame, every kind draws the same strip, and a heading never
 * sits alone at the foot of a page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REPORT_MARGIN } from '../export/report/compose.js';
import { composeDocument, estimateTextWidth, type DocumentLayout, type DrawnItem, type ResolvedBlock } from './compose.js';
import { BLOCK_TITLE_PAD } from './compose-block-title.js';
import { TABLE_ROW_HEIGHT } from './compose-table.js';
import { manualReportBlockFromChecklist } from './manual-report.js';
import type { IdsReportBlock } from './types.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';

const A4 = { w: 595.28, h: 841.89 };
const STYLE = { titleFontSize: 24, titleBackgroundColor: '#ffff00' } as const;
const LONG = 'Fire door in corridor 2.14 is missing its closer and label';
const PLACEHOLDER = '[BCF topic 1b8e-guid: not among the loaded topics]';

const IDS: IdsReportBlock = { kind: 'ids-report', id: 'ids', variant: 'compact', benchmarks: true, sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 10, passed: 7, failed: 3, passRate: 70 },
  checks: [{ id: 'walls', shortDescription: 'Walls', checked: 10, passed: 7, failed: 3, passRate: 70, rules: [] }] };
const MANUAL = manualReportBlockFromChecklist({
  checklist: { version: CHECKLIST_VERSION, name: 'Round 3', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'a', text: 'On time' }] }] },
  answers: { a: { status: 'pass', updatedAt: 1 } }, now: new Date(Date.UTC(2026, 8, 29)),
}, 'manual');
const KINDS = ['text', 'image', 'chart', 'topic', 'table', 'ids', 'manual'] as const;
const HALF_KINDS = ['text', 'image', 'chart'] as const;
const block = (kind: typeof KINDS[number], extra: object = {}): ResolvedBlock => {
  const title = `H:${kind}`;
  switch (kind) {
    case 'text': return { kind: 'text', id: kind, style: 'body', text: 'One short line', title, ...STYLE, ...extra } as ResolvedBlock;
    case 'image': return { kind: 'image', id: kind, height: 100, align: 'center', aspect: 2, title, ...STYLE, ...extra } as ResolvedBlock;
    case 'chart': return { kind: 'chart', id: kind, title, subtitle: '3 buckets', hasData: true, snapshot: false, height: 200, ...STYLE, ...extra } as ResolvedBlock;
    case 'topic': return { kind: 'topic', id: kind, title, authoredTitle: true, lines: ['Open'], snapshotAspect: null, ...STYLE, ...extra } as ResolvedBlock;
    case 'table': return { kind: 'table', id: kind, title, columns: [{ label: 'Name', numeric: false }], rows: [{ role: 'row' as const, cells: ['Wall'] }], ...STYLE, ...extra } as ResolvedBlock;
    case 'ids': return { ...IDS, title, ...STYLE, ...extra } as ResolvedBlock;
    case 'manual': return { ...MANUAL, title, ...STYLE, ...extra } as ResolvedBlock;
  }
};
const compose = (blocks: ResolvedBlock[], page: { size: 'A4' | 'A3'; orientation: 'portrait' | 'landscape' } = { size: 'A4', orientation: 'portrait' }): DocumentLayout =>
  composeDocument({ name: 'Doc', page, generatedAt: 'now', measure: estimateTextWidth, blocks });
const itemsOf = (layout: DocumentLayout): DrawnItem[] => layout.pages.flatMap((page) => page.items);
const stripOf = (layout: DocumentLayout) => {
  const found = itemsOf(layout).find((item) => item.kind === 'rect' && item.color === STYLE.titleBackgroundColor);
  assert.ok(found && found.kind === 'rect', 'the heading strip is drawn');
  return found;
};

describe('a topic heading that is not authored stays inside its strip (#6632 follow-up)', () => {
  for (const [label, title] of [['the topic\'s own title', LONG], ['the not-loaded placeholder', PLACEHOLDER]] as const) {
    for (const snapshotAspect of [null, 4 / 3]) {
      it(`${label}, ${snapshotAspect ? 'with' : 'without'} a snapshot, at the largest size: the text ends inside the strip and the frame`, () => {
        const layout = compose([block('topic', { title, authoredTitle: false, lines: title === LONG ? ['Status: Open'] : [], snapshotAspect })]);
        const strip = stripOf(layout);
        const text = itemsOf(layout).find((item) => item.kind === 'text' && item.bold && item.size === STYLE.titleFontSize);
        assert.ok(text && text.kind === 'text', 'the heading is drawn');
        const end = text.x + estimateTextWidth(text.text, text.size, true);
        assert.ok(end <= strip.x + strip.w - BLOCK_TITLE_PAD + 1e-6, `the heading "${text.text}" ends at ${end}, past its strip's inner edge ${strip.x + strip.w - BLOCK_TITLE_PAD}`);
        assert.ok(end <= A4.w - REPORT_MARGIN + 1e-6, `the heading ends at ${end}, past the right margin`);
      });
    }
  }
  it('an unstyled topic title keeps the width it is cut to, so nothing is cut that was not before', () => {
    const layout = compose([block('topic', { title: 'Short title', authoredTitle: false, titleFontSize: undefined, titleBackgroundColor: undefined })]);
    assert.ok(itemsOf(layout).some((item) => item.kind === 'text' && item.text === 'Short title'), 'a short fallback title is drawn whole');
  });
});

describe('every kind draws the same heading strip (#6632 follow-up)', () => {
  const pairs: Array<[string, { width?: 'half' }, readonly (typeof KINDS[number])[]]> = [['full width', {}, KINDS], ['half width', { width: 'half' }, HALF_KINDS]];
  for (const [label, width, kinds] of pairs) {
    for (const scale of [1, 1.5, 2]) {
      it(`${label}, block size ${scale}: the strip's left and right edges are the text block's`, () => {
        const edges = (kind: typeof KINDS[number]) => { const strip = stripOf(compose([block(kind, { scale, ...width })])); return [strip.x, strip.x + strip.w]; };
        const reference = edges('text');
        for (const kind of kinds) {
          const [left, right] = edges(kind);
          assert.ok(Math.abs(left - reference[0]) < 1e-6 && Math.abs(right - reference[1]) < 1e-6, `${kind}: strip [${left}, ${right}] against the text block's [${reference}]`);
        }
      });
    }
  }
  it('a chart title is still cut short of the column edge it was cut to before', () => {
    const long = 'W'.repeat(120);
    const layout = compose([block('chart', { title: long, titleBackgroundColor: undefined, titleFontSize: undefined })]);
    const text = itemsOf(layout).find((item) => item.kind === 'text' && item.bold);
    assert.ok(text && text.kind === 'text');
    assert.ok(text.x + estimateTextWidth(text.text, text.size, true) <= A4.w - REPORT_MARGIN - 4 + 1e-6, 'the text keeps its 4pt margin to the column edge');
  });
});

describe('a topic heading is never left alone at the foot of a page (#6632 follow-up)', () => {
  for (const size of [11, 24]) {
    it(`heading size ${size}: wherever it lands, it shares its page with the first lines of the topic`, () => {
      const lines = ['one', 'two', 'three', 'four'];
      const frame = A4.h - 2 * REPORT_MARGIN - 30 - 24;
      let crossed = false;
      for (let spacer = 0; spacer <= frame; spacer++) {
        const layout = compose([{ kind: 'spacer', id: 'sp', height: spacer } as ResolvedBlock, block('topic', { titleFontSize: size, lines })]);
        const page = layout.pages.find((candidate) => candidate.items.some((item) => item.kind === 'text' && item.text === 'H:topic'));
        assert.ok(page, 'the heading is drawn');
        if (layout.pages.indexOf(page) > 0) crossed = true;
        const body = page.items.filter((item) => item.kind === 'text' && lines.includes(item.text)).length;
        assert.ok(body >= 3, `spacer ${spacer}: the heading's page holds ${body} of the first 3 lines`);
      }
      assert.ok(crossed, 'the sweep reaches the page break, so the check is not vacuous');
    });
  }
});

describe('an enlarged heading keeps every kind inside the printable frame, snapshots included (#6632 follow-up)', () => {
  const PAGES = { A4: { portrait: [595.28, 841.89], landscape: [841.89, 595.28] }, A3: { portrait: [841.89, 1190.55], landscape: [1190.55, 841.89] } } as const;
  const bottomOf = (item: DrawnItem): number => item.kind === 'text' ? item.y : item.kind === 'ring' ? item.y + item.size : item.kind === 'table' ? item.y + (item.rows.length + 1) * TABLE_ROW_HEIGHT * (item.scale ?? 1) : item.y + item.h;
  for (const size of ['A4', 'A3'] as const) {
    for (const orientation of ['portrait', 'landscape'] as const) {
      it(`${size} ${orientation}: heading 24 on a strip, block size 0.5 to 2, a 3D snapshot beside the chart and the topic: nothing leaves the frame`, () => {
        const [w, h] = PAGES[size][orientation];
        for (const scale of [0.5, 1, 1.5, 2]) {
          const variants: ResolvedBlock[] = [
            ...KINDS.map((kind) => block(kind, { scale, ...(kind === 'image' ? { height: 3000, aspect: 0.2 } : {}), ...(kind === 'table' ? { rows: Array.from({ length: 200 }, () => ({ role: 'row' as const, cells: ['Wall'] })) } : {}) })),
            block('chart', { scale, snapshot: true, height: 600 }), block('topic', { scale, snapshotAspect: 2, lines: ['a', 'b'] }),
          ];
          for (const variant of variants) {
            for (const item of itemsOf(compose([variant], { size, orientation }))) {
              assert.ok(bottomOf(item) <= h - REPORT_MARGIN - 24 + 1e-6, `${variant.kind} at ${scale}: a ${item.kind} ends at ${bottomOf(item)}, past the frame's end ${h - REPORT_MARGIN - 24}`);
              if ('w' in item) assert.ok(item.x + item.w <= w - REPORT_MARGIN + 1e-6, `${variant.kind} at ${scale}: a ${item.kind} ends at x ${item.x + item.w}, past the right margin`);
            }
          }
        }
      });
    }
  }
});
