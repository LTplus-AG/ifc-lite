/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { runRuleSet, type RuleSetFile, type RuleBlock } from '@ifc-lite/rules';
import { composeDocument, estimateTextWidth, truncateToWidth, wrapText } from './compose.js';
import { layoutIdsReport } from './compose-ids-report.js';
import { layoutManualReport, type RingDrawnItem } from './compose-manual-report.js';
import { manualReportBlockFromChecklist } from './manual-report.js';
import type { LayoutCursor, TextDrawnItem } from './compose-table.js';
import { validationReportSnapshot } from '../validation/reports/history.js';
import { CHECKLIST_VERSION } from '../validation/manual/checklist.js';
import { pageBox, REPORT_MARGIN } from '../export/report/compose.js';

const WALL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('scope.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj000000000000000001',$,'Tower',$,$,$,$,$,$);
#40=IFCWALL('0Wall000000000000000001',$,'Fire wall',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const wrap = (text: string, width: number, size: number, bold: boolean) => wrapText(text, width, size, bold, estimateTextWidth);

/** The canonical engine really evaluates each loaded model. Scope is taken
 * from its report, not invented from a fabricated report fixture (#6500). */
async function scopedReport(count: number) {
  const bytes = new TextEncoder().encode(WALL);
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  const names = Array.from({ length: count }, (_, i) => `discipline-${i}-${'architectural-coordination-'.repeat(3)}delivery.ifc`);
  const models = new Map(names.map((name, i) => [`model-${i}`, { name, sourceFingerprint: `scope-${i}` }]));
  const filter: RuleBlock = { groups: [{ rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }], combinator: 'AND' }], authoredAs: 'chips' };
  const ruleSet: RuleSetFile = {
    version: 1, name: 'Federation scope',
    rules: [{ id: 'wall', name: 'Walls evaluated', applicability: filter, requirement: { kind: 'element', block: filter } }],
  };
  const report = await runRuleSet({ ruleSet, models: [...models.keys()].map((id) => ({ id, store })) });
  assert.equal(report.modelInfo.length, count);
  const snapshot = validationReportSnapshot(report, models, 'scope');
  assert.equal(snapshot.summary.checked, count);
  return { snapshot, names };
}

type Recorded = { page: number; item: TextDrawnItem | RingDrawnItem };

/** LayoutCursor's documented page-frame invariant: a populated page moves
 * before a reserved group crosses its bottom; a long group draws per line. */
function frame(height: number, atBottom: boolean) {
  const drawn: Recorded[] = [];
  let page = 0;
  const cursor: LayoutCursor = {
    x: 20, top: 30, bottom: 30 + height, y: atBottom ? height + 6 : 30,
    newPage: () => { page++; cursor.y = cursor.top; },
    ensure: (h) => { if (cursor.y + h > cursor.bottom && cursor.y > cursor.top) cursor.newPage(); },
    push: (...items) => {
      for (const item of items) {
        assert.equal(item.kind, 'text');
        if (item.kind !== 'text') assert.fail('report layout unexpectedly drew a table');
        drawn.push({ page, item });
      }
    },
    truncate: (text, width, size, bold) => truncateToWidth(text, width, size, bold, estimateTextWidth),
  };
  return { cursor, drawn, pushRing: (item: RingDrawnItem) => drawn.push({ page, item }) };
}

function assertComplete(drawn: Recorded[], names: string[], width: number, cursor: Pick<LayoutCursor, 'x' | 'top' | 'bottom'>) {
  const text = drawn.flatMap(({ item }) => item.kind === 'text' ? [item.text] : []).join('').replace(/\s/g, '');
  assert.ok(text.includes(`Models: ${names.join(', ')}`.replace(/\s/g, '')), 'every evaluated model name must be printed in full');
  for (const { item } of drawn) {
    assert.ok(item.y >= cursor.top && item.y <= cursor.bottom, 'each baseline stays in the page frame');
    if (item.kind === 'ring') assert.ok(item.y + item.size <= cursor.bottom, 'ring stays above the footer');
    else assert.ok(item.x + estimateTextWidth(item.text, item.size, item.bold) <= cursor.x + width + 0.01, 'text stays inside its full/half-width frame');
  }
}

describe('complete saved-report provenance (#6500)', () => {
  for (const width of [480, 240]) {
    it(`keeps real multi-model scope and first check together after a bottom boundary at ${width}pt`, async () => {
      const { snapshot, names } = await scopedReport(4);
      const { cursor, drawn, pushRing } = frame(500, true);
      layoutIdsReport(snapshot, cursor, width, 10, wrap, pushRing);
      assertComplete(drawn, names, width, cursor);
      const title = drawn.find(({ item }) => item.kind === 'text' && item.text.startsWith('Information validation report'));
      const firstCheck = drawn.find(({ item }) => item.kind === 'text' && item.text === 'Walls evaluated');
      assert.equal(title?.page, 1);
      assert.equal(firstCheck?.page, title?.page, 'heading, full scope and first check move together when they fit');
    });
  }

  for (const kind of ['ids', 'manual', 'manual-empty'] as const) {
    it(`${kind} provenance taller than one narrow page prints every name without overflow`, async () => {
      const { snapshot, names } = await scopedReport(24);
      const { cursor, drawn, pushRing } = frame(180, true);
      if (kind === 'ids') layoutIdsReport(snapshot, cursor, 180, 10, wrap, pushRing);
      else {
        const block = manualReportBlockFromChecklist({
          checklist: { version: CHECKLIST_VERSION, name: 'Scope review', groups: kind === 'manual-empty' ? [] : [{ id: 'g', name: 'Delivery', items: [{ id: 'i', text: 'Origin reviewed' }] }] },
          answers: { i: { status: 'pass', updatedAt: 1 } },
        }, 'manual');
        layoutManualReport({ ...block, reportModels: snapshot.reportModels }, cursor, 180, 10, wrap, pushRing);
      }
      assertComplete(drawn, names, 180, cursor);
      assert.ok(drawn.at(-1)!.page > 2, 'oversized scope really crossed multiple pages');
      const followingIndex = drawn.findIndex(({ item }) => kind === 'ids' ? item.kind === 'text' && item.text === 'Walls evaluated' : item.kind === 'ring');
      assert.ok(followingIndex > 0);
      assert.equal(drawn[followingIndex - 1].page, drawn[followingIndex].page, 'final provenance line stays with the first check/ring');
    });
  }

  for (const variant of [undefined, 'long', 'compact'] as const) {
    it(`the production ${variant ?? 'original'} composer retains complete scope beyond a nearly-full page`, async () => {
      const { snapshot, names } = await scopedReport(80);
      const page = { size: 'A4', orientation: 'portrait' } as const;
      const size = pageBox(page);
      const top = REPORT_MARGIN + 30;
      const bottom = size.h - REPORT_MARGIN - 24;
      const layout = composeDocument({ name: 'Scope evidence', page, generatedAt: '', measure: estimateTextWidth, blocks: [{ kind: 'spacer', id: 'bottom', height: bottom - top - 25 }, { ...snapshot, ...(variant ? { variant } : {}) }] });
      const drawn = layout.pages.flatMap((p) => p.items.flatMap((item): Recorded[] => item.kind === 'text' || item.kind === 'ring' ? [{ page: p.index, item }] : []));
      assertComplete(drawn, names, size.w - 2 * REPORT_MARGIN, { x: REPORT_MARGIN, top, bottom });
      assert.ok(layout.pages.length >= 3);
    });
  }
});
