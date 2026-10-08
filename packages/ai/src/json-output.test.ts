/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseJsonOutput } from './json-output.js';
import { anthropicUsage, chatCompletionsUsage, responsesUsage } from './usage.js';

const limits = { maxChars: 200, maxDepth: 3, maxNodes: 20 };

describe('parseJsonOutput', () => {
  it('accepts a whole reply or a whole fenced reply', () => {
    expect(parseJsonOutput('{"items":[1,2]}', limits)).toEqual({ ok: true, value: { items: [1, 2] } });
    expect(parseJsonOutput('```json\n{"a":1}\n```', limits)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('never extracts JSON from surrounding prose', () => {
    expect(parseJsonOutput('Here you go: {"a":1}', limits)).toMatchObject({ ok: false, reason: 'not-json' });
    expect(parseJsonOutput('```json\n{"a":1}\n``` thanks', limits)).toMatchObject({ ok: false, reason: 'not-json' });
  });

  it('refuses a truncated reply even when it parses', () => {
    expect(parseJsonOutput('{"a":1}', limits, true)).toMatchObject({ ok: false, reason: 'truncated' });
  });

  it('bounds size, depth and value count', () => {
    expect(parseJsonOutput(`"${'x'.repeat(300)}"`, limits)).toMatchObject({ ok: false, reason: 'too-large' });
    expect(parseJsonOutput('[[[[1]]]]', limits)).toMatchObject({ ok: false, reason: 'too-deep' });
    expect(parseJsonOutput(JSON.stringify(Array.from({ length: 30 }, (_, i) => i)), limits)).toMatchObject({ ok: false, reason: 'too-many-values' });
  });

  it('refuses prototype keys at any depth', () => {
    expect(parseJsonOutput('{"a":{"__proto__":{"polluted":true}}}', limits)).toMatchObject({ ok: false, reason: 'forbidden-key' });
  });
});

describe('usage parsers', () => {
  it('read only complete counts', () => {
    expect(chatCompletionsUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(chatCompletionsUsage({ usage: { prompt_tokens: 3 } })).toBeNull();
    expect(responsesUsage({ response: { usage: { input_tokens: 5, output_tokens: 6 } } })).toEqual({ inputTokens: 5, outputTokens: 6 });
    expect(anthropicUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 })).toEqual({ inputTokens: 15, outputTokens: 2 });
  });
});
