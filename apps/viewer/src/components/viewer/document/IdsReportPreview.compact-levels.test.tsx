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
import { cleanup, render } from '@/test/render.js';
import type { IdsReportBlock } from '@/lib/document/types';
import { IdsReportPreview } from './IdsReportPreview.js';

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
