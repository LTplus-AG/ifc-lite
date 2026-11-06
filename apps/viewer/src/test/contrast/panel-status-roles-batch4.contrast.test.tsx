/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TableMappingCard } from '@/components/viewer/actions/TableMappingCard.js';
import { BCFOutboxEntry } from '@/components/viewer/bcf/BCFOutboxEntry.js';
import type { BcfPublication, OutboxEntry } from '@/lib/bcf-publication/outbox-types.js';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, withThemedPage, measureTextContrastOnSurface, type Theme } from './render-harness.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

afterEach(cleanup);
after(closeContrastBrowser);
const entry: OutboxEntry = {
  id: 'failed-entry', operation: 'createTopic', topicGuid: 'topic', payload: {}, digest: 'digest',
  state: 'failed', attempts: 1, queuedAt: '2026-11-06T00:00:00Z',
  failure: { code: 'rejected', message: 'Server rejected publication', at: '2026-11-06T00:00:00Z' },
};
const record: BcfPublication = {
  version: 1, id: 'publication', origin: 'draft',
  target: { serverUrl: 'https://example.invalid/bcf', projectId: 'project', userId: 'author' },
  createdAt: entry.queuedAt, updatedAt: entry.queuedAt, entries: [entry],
};

// Refs #8802 batch 4: real rejected publication and invalid mapping conditions.
// The DOM checks are also a bounded revert oracle independent of browser launch.
const states = [
  {
    // TableMappingCard paints its section bg-primary/5 over the card, so the warning is measured on that stack.
    name: 'table mapping references a column absent from the imported headers', role: 'warn', selector: '[role="alert"]',
    surface: 'bg-primary/5', backdrop: 'bg-card',
    mount: () => render(<TableMappingCard modelId="missing-model" headers={['GlobalId']} rows={[]}
      mapping={{ version: 1, kind: 'table.mapping', title: 'Mapping', identity: { column: 'GlobalId', key: 'GlobalId' },
        columns: [{ column: 'Absent', target: 'attribute', name: 'Name' }] }}
      onChange={() => {}} onReview={() => {}} onDiscard={() => {}} />),
  },
  {
    name: 'BCF publication was definitely rejected by the server', role: 'danger', selector: 'li > div > span:last-child',
    surface: 'bg-card', backdrop: undefined,
    mount: () => render(<BCFOutboxEntry record={record} entry={entry} label="Topic" connection={null} />),
  },
];

describe('panel status roles batch 4 (Refs #8802)', () => {
  for (const state of states) {
    it(`${state.name} renders its status role`, () => {
      const ui = state.mount();
      const notice = ui.querySelector(state.selector);
      assert.ok(notice, 'the status element renders');
      assert.ok(notice.textContent?.trim(), 'real status is visible');
      assert.ok(notice.classList.contains(`text-${state.role}`), 'status uses its colour role');
    });
    for (const theme of ['light', 'dark', 'colorful'] as Theme[]) {
      it(`${state.name} paints its role and clears AA in ${theme}`, async () => {
        const ui = state.mount();
        const notice = ui.querySelector(state.selector);
        assert.ok(notice);
        await withThemedPage(theme, `<div class="bg-card text-foreground">${ui.innerHTML}</div><span id="expected" class="text-${state.role}"></span>`, async page => {
          const actual = await page.$eval(state.selector, el => getComputedStyle(el).color);
          const expected = await page.$eval('#expected', el => getComputedStyle(el).color);
          assert.equal(actual, expected, 'status paints its role');
        });
        const ratio = await measureTextContrastOnSurface(theme, state.surface, notice.className, state.backdrop);
        assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `status contrast ${ratio.toFixed(2)}:1 in ${theme}`);
      });
    }
  }
});
