/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact IDS report (#6550): a specification and its requirements must read
 * as two levels. The preview nests each specification's requirement rows
 * under it, the way the PDF indents them.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, waitFor } from '@/test/render.js';
import { DOCUMENT_VERSION, type IdsReportBlock } from '@/lib/document/types';
import { IdsReportPreview } from './IdsReportPreview.js';
import { DocumentPreview } from './DocumentPreview.js';

const rule = (id: string, name: string) => ({ id, name, shortDescription: `${name} must exist`, checked: 6, passed: 6, failed: 0, passRate: 100 });
const block: IdsReportBlock = {
  kind: 'ids-report', id: 'b', variant: 'compact', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 12, passed: 12, failed: 0, passRate: 100 },
  checks: [
    { id: 's1', shortDescription: 'Geschoss', checked: 6, passed: 6, failed: 0, passRate: 100, rules: [rule('r1', 'Status'), rule('r2', 'Material')] },
    { id: 's2', shortDescription: 'Raum', checked: 6, passed: 6, failed: 0, passRate: 100, rules: [rule('r3', 'Raumname')] },
  ],
};

afterEach(cleanup);

describe('compact IDS report preview levels (#6550)', () => {
  it('groups requirement rows inside their specification, not beside it', () => {
    const ui = render(<IdsReportPreview block={block} />);
    const specs = [...ui.querySelectorAll('[data-ids-report-spec]')];
    assert.equal(specs.length, 2, 'one group per specification');
    const names = (el: Element) => [...el.querySelectorAll('[data-ids-report-requirements] [data-ids-report-row]')].map((r) => (r.textContent ?? '').replace(/[\d/·%\s]+$/, '').trim());
    assert.deepEqual(names(specs[0]), ['Status', 'Material']);
    assert.deepEqual(names(specs[1]), ['Raumname']);
    const heads = [...ui.querySelectorAll('[data-ids-report-spec] > ul > [data-ids-report-row]')].map((r) => (r.textContent ?? '').replace(/[\d/·%\s]+$/, '').trim());
    assert.deepEqual(heads, ['Geschoss', 'Raum'], 'the specification row heads its group');
  });
});

it('keeps compact specification hierarchy in the canonical document sheets (#6550, #6660)', async () => {
  const ui = render(<DocumentPreview document={{ version: DOCUMENT_VERSION, id: 'compact-levels', name: 'Design review',
    page: { size: 'A4', orientation: 'portrait' }, blocks: [block] }}
    bindings={{ models: [], activeModelId: null, today: new Date('2026-10-02T12:00:00Z') }}
    aggregations={new Map()} chartMessages={new Map()} topics={new Map()}
    selectedBlockId={null} onSelectBlock={() => {}} />);
  await waitFor(() => ui.querySelector('[data-preview-section]') !== null
    && ui.querySelector('[data-layout-pending="true"]') === null, 'actual shared compact layout is prepared');
  const glyph = (text: string) => {
    const node = Array.from(ui.querySelectorAll<HTMLElement>('[data-preview-block="b"] span'))
      .find(element => element.textContent?.trim() === text);
    assert.ok(node, `the shared composer actually renders ${text}`);
    return node;
  };
  const first = glyph('Geschoss'), second = glyph('Raum');
  const status = glyph('Status'), material = glyph('Material'), room = glyph('Raumname');
  assert.equal(first.style.fontWeight, '700'); assert.equal(second.style.fontWeight, '700');
  for (const [child, parent] of [[status, first], [material, first], [room, second]]) {
    assert.ok(parseFloat(child.style.left) > parseFloat(parent.style.left), 'requirements remain visibly indented');
    assert.equal(child.style.fontWeight, '400');
  }
  const rowGap = parseFloat(material.style.top) - parseFloat(status.style.top);
  const groupGap = parseFloat(second.style.top) - parseFloat(material.style.top);
  assert.ok(groupGap > rowGap + 3, 'extra space distinguishes the next specification from another requirement');
});
