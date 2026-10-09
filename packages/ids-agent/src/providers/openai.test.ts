/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { emptyDoc, schemaContexts } from '../../test/helpers.js';
import { runAgent } from '../runner/loop.js';
import { fromChatResponse, openAiTransport, toChatMessages } from './openai.js';

function replayFetch(bodies: unknown[]) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = bodies[requests.length - 1];
    return body === undefined ? new Response('{}', { status: 429 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchImpl: fetchImpl as typeof fetch, requests };
}

const toolCallResponse = {
  model: 'gpt-test',
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'schema_entity', arguments: '{"name":"IfcDoor","version":"IFC4"}' } }] } }],
  usage: { prompt_tokens: 900, completion_tokens: 30 },
};
const finalResponse = { model: 'gpt-test', choices: [{ finish_reason: 'stop', message: { content: 'IfcDoor has a door type.' } }], usage: { prompt_tokens: 1100, completion_tokens: 9 } };

describe('OpenAI Chat Completions adapter', () => {
  it('runs a recorded tool-call round trip', async () => {
    const { gate, lint } = await schemaContexts();
    const { fetchImpl, requests } = replayFetch([toolCallResponse, finalResponse]);
    const run = await runAgent({
      transport: openAiTransport({ apiKey: 'test-key-not-a-secret', baseUrl: 'https://example.invalid/v1/' }, fetchImpl),
      model: 'gpt-test', route: 'openai', mode: 'explain', request: 'Tell me about doors.', doc: emptyDoc(), gate, lint,
    });
    expect(run.status).toBe('completed');
    expect(run.proposal.summary).toBe('IfcDoor has a door type.');
    expect(requests[0].url).toBe('https://example.invalid/v1/chat/completions');
    expect(requests[0].headers.get('authorization')).toBe('Bearer test-key-not-a-secret');
    const tools = requests[0].body.tools as { type: string; function: { name: string; parameters: unknown } }[];
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'schema_search_entities' } });
    const messages = requests[1].body.messages as { role: string; content?: string | null; tool_call_id?: string; tool_calls?: unknown[] }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[1].content).toContain('Current IDS document');
    expect(messages[2].tool_calls).toHaveLength(1);
    expect(messages[3]).toMatchObject({ tool_call_id: 'call_1' });
    expect(run.proposal.receipt.requests[0]).toMatchObject({ usageReported: true, inputTokens: 900, outputTokens: 30, model: 'gpt-test' });
  });

  it('passes unparseable arguments on as raw input, which the registry refuses to run', async () => {
    const turn = fromChatResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'ids_read', arguments: '{"view": "summ' } }] } }] });
    expect(turn.content[0]).toMatchObject({ type: 'tool_call', rawInput: '{"view": "summ' });
    const { gate, lint } = await schemaContexts();
    const { fetchImpl, requests } = replayFetch([
      { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: 'ids_read', arguments: '{"view": "summ' } }] } }] },
      finalResponse,
    ]);
    await runAgent({ transport: openAiTransport({ apiKey: 'k' }, fetchImpl), mode: 'explain', request: 'x', doc: emptyDoc(), gate, lint });
    const toolMessage = (requests[1].body.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('INVALID_JSON');
  });

  it('maps finish reasons and refusals', () => {
    expect(fromChatResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stopReason).toBe('max_tokens');
    expect(fromChatResponse({ choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }] })).toMatchObject({ stopReason: 'refusal', refusal: { explanation: 'no' } });
    expect(fromChatResponse({}).stopReason).toBe('other');
  });

  it('replays a tool call that had invalid JSON as its raw text', () => {
    const messages = toChatMessages({ system: 's', messages: [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c', name: 'ids_read', input: undefined, rawInput: '{bad' }] },
      { role: 'tool', results: [{ callId: 'c', content: '{"error":"INVALID_JSON"}', isError: true }] },
    ] });
    expect(messages[2]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ function: { arguments: '{bad' } }] });
  });

  it('reports an HTTP failure as a run error', async () => {
    const { gate, lint } = await schemaContexts();
    const { fetchImpl } = replayFetch([]);
    const run = await runAgent({ transport: openAiTransport({ apiKey: 'k' }, fetchImpl), mode: 'explain', request: 'x', doc: emptyDoc(), gate, lint });
    expect(run).toMatchObject({ status: 'error', message: 'the AI provider answered HTTP 429' });
  });
});
