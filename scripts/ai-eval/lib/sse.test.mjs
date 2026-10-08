/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { foldEvents, outcomeOf, parseEvents, sseData } from './sse.mjs';

const chat = (text, extra = {}) => ({ choices: [{ delta: { content: text }, ...extra }] });

test('sseData keeps payloads in order, joins multi-line data and drops [DONE]', () => {
  const wire = 'data: {"a":1}\r\n\r\nevent: x\ndata: {"b":\ndata: 2}\n\ndata: [DONE]\n\n';
  assert.deepEqual(sseData(wire), ['{"a":1}', '{"b":\n2}']);
});

test('parseEvents keeps an unparseable payload instead of losing it', () => {
  assert.deepEqual(parseEvents(['{"a":1}', 'not json']), [{ a: 1 }, { unparsed: 'not json' }]);
});

test('chat completions fold text, finish reason and the trailing usage chunk; the proxy quota event is ignored', () => {
  const folded = foldEvents('openai', [chat('Hel'), chat('lo'), { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { __ifcLiteUsage: { remaining: 3 } }, { choices: [], usage: { prompt_tokens: 120, completion_tokens: 7 } }]);
  assert.deepEqual(folded, { text: 'Hello', finishReason: 'stop', usage: { inputTokens: 120, outputTokens: 7 } });
});

test('anthropic folds text deltas, message_start/message_delta usage and stop_reason', () => {
  const folded = foldEvents('anthropic', [
    { type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 1 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 9 } }]);
  assert.deepEqual(folded, { text: 'Hi there', finishReason: 'max_tokens', usage: { inputTokens: 40, outputTokens: 9 } });
});

test('usage is null when the stream carried none: nothing is estimated', () => {
  assert.equal(foldEvents('openai', [chat('x')]).usage, null);
  assert.equal(foldEvents('anthropic', [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }]).usage, null);
});

test('outcomeOf mirrors the viewer: non-200 and empty are errors, length and max_tokens are truncated', () => {
  assert.equal(outcomeOf(429, { text: 'x', finishReason: null }), 'error');
  assert.equal(outcomeOf(200, { text: '  ', finishReason: 'stop' }), 'error');
  assert.equal(outcomeOf(200, { text: 'x', finishReason: 'length' }), 'truncated');
  assert.equal(outcomeOf(200, { text: 'x', finishReason: 'max_tokens' }), 'truncated');
  assert.equal(outcomeOf(200, { text: 'x', finishReason: 'stop' }), 'completed');
});
