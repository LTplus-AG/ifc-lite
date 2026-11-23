/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitA2uiReply, stripA2uiBlocks } from './a2ui-blocks';
import { extractCodeBlocks } from './code-extractor';
import { insertA2uiSection } from './a2ui-prompt';
import { buildSystemPrompt } from './system-prompt';

const kinds = (content: string) => splitA2uiReply(content).map((p) => (p.kind === 'text' ? `t:${p.text}` : `b:${p.closed}`));

describe('splitA2uiReply', () => {
  it('keeps a script that mentions the tag runnable, and a fenced surface out of the scripts', () => {
    assert.equal(extractCodeBlocks('```js\nconst tag = "<a2ui>";\nconsole.log(tag);\n```').length, 1);
    assert.equal(extractCodeBlocks('```\n<a2ui>\nroot = Text("x")\n</a2ui>\n```').length, 0);
  });

  it('renders a fenced surface with a blank line after the fence', () => {
    assert.deepEqual(kinds('```a2ui\n\n<a2ui>\nroot = Text("x")\n</a2ui>\n```'), ['b:true']);
  });

  it('keeps the closing fence of a code block that sits right before a surface', () => {
    const reply = 'Run:\n```js\nbim.query()\n```\n<a2ui>\nroot = Text("x")\n</a2ui>\nDone';
    assert.deepEqual(kinds(reply), ['t:Run:\n```js\nbim.query()\n```\n', 'b:true', 't:\nDone']);
    assert.equal(extractCodeBlocks(reply).length, 1);
  });

  it('drops a fence that wraps a block, so the next code block still pairs', () => {
    const reply = 'A\n```\n<a2ui>\nroot = Text("x")\n</a2ui>\n```\nB\n```js\nbim.query()\n```';
    assert.deepEqual(kinds(reply), ['t:A\n', 'b:true', 't:\nB\n```js\nbim.query()\n```']);
    const code = extractCodeBlocks(reply);
    assert.deepEqual(code.map((c) => c.code), ['bim.query()'], 'the wrapped block is not a script');
  });

  it('treats a block still streaming as unclosed, and partial tags as prose until complete', () => {
    assert.deepEqual(kinds('Hi <a2'), ['t:Hi <a2']);
    assert.deepEqual(kinds('Hi <a2ui>\nroot = Te'), ['t:Hi ', 'b:false']);
    assert.equal(stripA2uiBlocks('Hi <a2ui>\nroot = Te'), 'Hi \n');
  });
});

describe('A2UI prompt section', () => {
  it('goes before the personal overlay, so the shared prompt prefix stays cacheable', () => {
    const prompt = buildSystemPrompt(undefined, [], undefined, { personalOverlay: 'Prefer metric.' });
    const merged = insertA2uiSection(prompt, '## INTERACTIVE ANSWERS (A2UI)');
    assert.ok(merged.indexOf('## INTERACTIVE ANSWERS (A2UI)') < merged.indexOf('## PERSONAL CONTEXT'));
    assert.ok(merged.trimEnd().endsWith('Prefer metric.'));
    assert.ok(insertA2uiSection('base', 'X').endsWith('\n\nX'));
    assert.equal(insertA2uiSection('base', ''), 'base');
  });
});
