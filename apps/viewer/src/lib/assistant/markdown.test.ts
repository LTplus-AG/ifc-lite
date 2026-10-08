/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownHtml, parseMarkdown, plainInline } from './markdown';

// Shape of a real free-model answer (z-ai/glm-5.3-flash on AC20-FZK-Haus, 2026-10-04).
const ANSWER = `## Severity: no high-severity findings

All 155 findings carry **info** severity [E1], [E2].

| Type pair | Count |
|---|---|
| IfcBeam vs IfcMember | 84 |
| IfcMember vs IfcSlab | 42 |

## Limitations
- Distances are \`estimate\` values
  that are not exact geometry.
- Only 75 of 155 rows are included.

1. Review slab joins
2. Re-run detection
---
\`\`\`json
{"kind": "x"}
\`\`\``;

test('parses the Markdown subset models emit into document-ready blocks', () => {
  assert.deepEqual(parseMarkdown(ANSWER).map(block => block.kind), ['heading', 'paragraph', 'table', 'heading', 'list', 'list', 'rule', 'code']);
  const [, , table, , bullets, ordered] = parseMarkdown(ANSWER);
  assert.deepEqual(table, { kind: 'table', header: ['Type pair', 'Count'], rows: [['IfcBeam vs IfcMember', '84'], ['IfcMember vs IfcSlab', '42']] });
  assert.deepEqual(bullets, { kind: 'list', ordered: false, items: ['Distances are `estimate` values that are not exact geometry.', 'Only 75 of 155 rows are included.'] });
  assert.equal(ordered.kind === 'list' && ordered.ordered, true);
  assert.equal(plainInline('**info** severity and `estimate` *values*'), 'info severity and estimate values');
});

test('renders escaped HTML with citation chips and never emits model markup', () => {
  const host = document.createElement('div');
  host.innerHTML = markdownHtml(`${ANSWER}\n\n<script>bad()</script> <img src=x onerror=bad()> [link](javascript:bad()) [E12]`);
  assert.equal(host.querySelector('script, img, a, iframe'), null);
  assert.match(host.textContent ?? '', /<script>bad\(\)<\/script>/);
  assert.equal(host.querySelectorAll('table tbody tr').length, 2);
  assert.equal(host.querySelectorAll('ul li').length, 2);
  assert.equal(host.querySelectorAll('ol li').length, 2);
  assert.deepEqual([...host.querySelectorAll('button[data-citation]')].map(chip => chip.getAttribute('data-citation')), ['E1', 'E2', 'E12']);
  assert.equal(host.querySelector('strong')?.textContent, 'info');
  assert.doesNotMatch(host.textContent ?? '', /^##|\|---\|/m);
});
