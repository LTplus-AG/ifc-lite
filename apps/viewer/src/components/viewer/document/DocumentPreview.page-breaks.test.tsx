/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, waitFor } from '@/test/render.js';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types.js';
import { DocumentPreview } from './DocumentPreview.js';

const spec: DocumentSpec = {
  version: DOCUMENT_VERSION, id: 'pages', name: 'Authored sections', page: { size: 'A4', orientation: 'portrait' },
  blocks: [
    { kind: 'page-break', id: 'leading' },
    { kind: 'text', id: 'a', style: 'body', text: 'Before the break', width: 'half' },
    { kind: 'page-break', id: 'break' }, { kind: 'page-break', id: 'repeat' },
    { kind: 'text', id: 'b', style: 'body', text: 'After the break', width: 'half' },
    { kind: 'text', id: 'c', style: 'body', text: 'Paired after the break', width: 'half' },
    { kind: 'page-break', id: 'trailing' },
  ],
};

describe('DocumentPreview explicit page breaks (#6485)', () => {
  afterEach(cleanup);
  it('shows distinct paper sections, skips edge/repeated breaks and keeps selection and half rows in the proper section', async () => {
    let selected = '';
    const ui = render(<DocumentPreview document={spec} bindings={{ models: [], activeModelId: null, today: new Date(0) }} aggregations={new Map()} chartMessages={new Map()} topics={new Map()} selectedBlockId={null} onSelectBlock={(id) => { selected = id; }} />);
    await waitFor(() => ui.querySelector('[data-preview-section]') !== null, 'shared document layout ready');
    const papers = ui.querySelectorAll('[data-preview-section]');
    assert.equal(papers.length, 2);
    assert.equal(papers[0].getAttribute('aria-label'), 'Document section 1');
    assert.equal(papers[1].getAttribute('aria-label'), 'Document section 2');
    assert.deepEqual(Array.from(papers[0].querySelectorAll('[data-preview-block]'), (block) => block.getAttribute('data-preview-block')), ['a']);
    assert.deepEqual(Array.from(papers[1].querySelectorAll('[data-preview-block]'), (block) => block.getAttribute('data-preview-block')), ['b', 'c']);
    const b = papers[1].querySelector<HTMLElement>('[data-preview-block="b"]');
    const c = papers[1].querySelector<HTMLElement>('[data-preview-block="c"]');
    assert.ok(b && c);
    assert.equal(b.style.top, c.style.top, 'adjacent halves still share the composed row');
    assert.ok(parseFloat(c.style.left) > parseFloat(b.style.left) + parseFloat(b.style.width), 'the second half starts beyond the first ink column');
    const after = papers[1].querySelector('[data-preview-block="b"]');
    assert.ok(after);
    click(after);
    assert.equal(selected, 'b');
  });
});
