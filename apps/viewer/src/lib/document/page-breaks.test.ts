/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeDocument, estimateTextWidth } from './compose.js';
import { DOCUMENT_VERSION, migrateDocumentSpec, validateDocumentSpec, type DocumentSpec, type DocumentBlock } from './types.js';
import { parseDocumentFile } from './persistence.js';
import { resolveBlocks } from './generate-document-pdf.js';
import { splitDocumentSections } from './page-sections.js';
import { REPORT_MARGIN } from '../export/report/compose.js';

const text = (id: string, width: 'full' | 'half' = 'full'): DocumentBlock => ({ kind: 'text', id, text: id, style: 'body', width, backgroundColor: '#abcdef' });
const br = (id: string): DocumentBlock => ({ kind: 'page-break', id });
const document = (blocks: DocumentBlock[]): DocumentSpec => ({ version: DOCUMENT_VERSION, id: 'pages', name: 'Pages', page: { size: 'A4', orientation: 'portrait' }, blocks });
async function layout(blocks: DocumentBlock[]) {
  const resolved = await resolveBlocks({ document: document(blocks), bindings: { models: [], activeModelId: null, today: new Date(0) }, aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] }, async () => ({ w: 1, h: 1 }), { unresolved: [], missingTopics: [], tableFailures: [] });
  return composeDocument({ ...document(blocks), blocks: resolved, generatedAt: '', measure: estimateTextWidth });
}

describe('Explicit document page breaks (#6485)', () => {
  it('preserves page breaks through template import while migrating every earlier document version', () => {
    const spec = document([text('before'), br('break'), text('after')]);
    assert.deepEqual(validateDocumentSpec(spec), []);
    const imported = parseDocumentFile(JSON.stringify(spec));
    assert.deepEqual(imported.blocks.map((block) => block.kind), ['text', 'page-break', 'text']);
    assert.equal(new Set(imported.blocks.map((block) => block.id)).size, 3);
    assert.notEqual(imported.blocks[1].id, 'break');
    for (let version = 1; version < DOCUMENT_VERSION; version++) {
      const old = { ...document([text('old')]), version };
      assert.deepEqual(validateDocumentSpec(migrateDocumentSpec(old)), []);
      assert.equal(parseDocumentFile(JSON.stringify(old)).version, DOCUMENT_VERSION);
    }
    assert.ok(validateDocumentSpec(document([{ kind: 'page-break', id: '' }])).some((error) => error.path === 'blocks[0].id'));
  });

  it('starts following content at the page top and prevents half-width pairing across the break', async () => {
    for (const width of ['full', 'half'] as const) {
      const composed = await layout([text('before', width), br('break'), text('after', width)]);
      assert.equal(composed.pages.length, 2);
      for (const [index, page] of composed.pages.entries()) {
        const ink = page.items.filter((item) => item.kind === 'text');
        assert.deepEqual(ink.map((item) => item.text), [index === 0 ? 'before' : 'after']);
        const fill = page.items.find((item) => item.kind === 'text-background');
        assert.ok(fill?.kind === 'text-background');
        assert.equal(fill.x, REPORT_MARGIN);
        assert.equal(fill.w, composed.size.w - 2 * REPORT_MARGIN, 'unpaired halves use full width');
        assert.equal(fill.y, REPORT_MARGIN + 30);
      }
    }
  });

  it('retains paired columns within each section, with neither ink nor backgrounds crossing pages', async () => {
    const composed = await layout([text('a', 'half'), text('b', 'half'), br('break'), text('c', 'half'), text('d', 'half')]);
    assert.equal(composed.pages.length, 2);
    for (const [index, page] of composed.pages.entries()) {
      const ink = page.items.filter((item) => item.kind === 'text');
      assert.deepEqual(ink.map((item) => item.text), index === 0 ? ['a', 'b'] : ['c', 'd']);
      assert.equal(ink[0].y, ink[1].y);
      assert.ok(ink[1].x > ink[0].x);
      const fills = page.items.filter((item) => item.kind === 'text-background');
      assert.equal(fills.length, 2);
      assert.ok(fills.every((fill) => fill.w < composed.size.w / 2));
    }
  });

  it('coalesces consecutive and edge breaks without creating blank pages', async () => {
    const blocks = [br('leading'), text('a'), br('middle'), br('middle2'), text('b'), br('trailing')];
    assert.deepEqual(splitDocumentSections(blocks).map((section) => section.map((block) => block.id)), [['a'], ['b']]);
    assert.equal((await layout(blocks)).pages.length, 2);
    assert.equal((await layout([br('only'), br('another')])).pages.length, 1, 'an empty document still has one page');
  });

  it('continues automatic text pagination then applies the authored break exactly once', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Line ${i}`);
    const long: DocumentBlock = { kind: 'text', id: 'long', style: 'body', text: lines.join('\n') };
    const auto = await layout([long]);
    assert.ok(auto.pages.length > 1);
    const explicit = await layout([long, br('break'), text('after')]);
    assert.equal(explicit.pages.length, auto.pages.length + 1);
    assert.deepEqual(explicit.pages.slice(0, -1).flatMap((page) => page.items.filter((item) => item.kind === 'text').map((item) => item.text)), lines);
    const last = explicit.pages.at(-1)!;
    assert.deepEqual(last.items.filter((item) => item.kind === 'text').map((item) => item.text), ['after']);
    assert.equal(last.items[0].y, REPORT_MARGIN + 30);
  });
});
