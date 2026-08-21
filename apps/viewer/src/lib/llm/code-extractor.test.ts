/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeBlocks, injectCsvData } from './code-extractor.js';

describe('extractCodeBlocks', () => {
  it('extracts a plain ```js block (LF line endings)', () => {
    const md = 'Here:\n```js\nconsole.log(1);\n```\n';
    const blocks = extractCodeBlocks(md);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, 'console.log(1);');
    assert.equal(blocks[0].index, 0);
  });

  it('extracts a ```js block with CRLF line endings (pasted/Windows-authored content)', () => {
    // Regression: the fence regex required a literal \n right after the
    // language tag. A CRLF source has \r there instead, so the regex never
    // matched at all and the block silently rendered as plain text with no
    // Run affordance - the exact "absence as success" failure mode.
    const md = 'Here:\r\n```js\r\nconsole.log(1);\r\n```\r\n';
    const blocks = extractCodeBlocks(md);
    assert.equal(blocks.length, 1, 'expected the CRLF code block to be recognised');
    assert.equal(blocks[0].code.trim(), 'console.log(1);');
  });

  it('extracts a bare (unlabeled) block with CRLF line endings', () => {
    const md = '```\r\nbim.getSelectedEntities();\r\n```\r\n';
    const blocks = extractCodeBlocks(md);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].code.includes('bim.'));
  });

  it('assigns sequential indices only to extracted (executable) blocks', () => {
    const md = [
      '```json\n{"a":1}\n```',
      '```js\nconsole.log(1);\n```',
      '```js\nconsole.log(2);\n```',
    ].join('\n\n');
    const blocks = extractCodeBlocks(md);
    assert.deepEqual(blocks.map((b) => b.index), [0, 1]);
    assert.deepEqual(blocks.map((b) => b.code), ['console.log(1);', 'console.log(2);']);
  });

  it('skips a non-executable, non-bim block (e.g. json/html)', () => {
    const md = '```json\n{"a":1}\n```';
    assert.deepEqual(extractCodeBlocks(md), []);
  });

  it('includes an unlabeled block that references bim. even if language is not js', () => {
    const md = '```python\nbim.doSomething()\n```';
    const blocks = extractCodeBlocks(md);
    assert.equal(blocks.length, 1);
  });
});

describe('injectCsvData', () => {
  it('prepends a DATA declaration before the script body', () => {
    const out = injectCsvData('console.log(DATA);', [{ a: '1' }]);
    assert.ok(out.startsWith('const DATA = [{"a":"1"}];'));
    assert.ok(out.endsWith('console.log(DATA);'));
  });
});
