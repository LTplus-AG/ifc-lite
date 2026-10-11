/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tool-call round trip through the real Anthropic SDK, with `fetch` replaced
 * by a replay of Messages API event streams (`test/fixtures/*.sse`, written
 * by hand in the documented SSE format; no live call, no key).
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptyDoc, schemaContexts } from '../../test/helpers.js';
import { runAgent } from '../runner/loop.js';
import { anthropicTransport, buildAnthropicParams } from './anthropic.js';

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), 'utf8');

interface Captured { url: string; headers: Headers; body: Record<string, unknown> }

function replayClient(streams: string[]): { client: Anthropic; requests: Captured[] } {
  const requests: Captured[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const body = streams[requests.length - 1];
    if (body === undefined) return new Response('{"type":"error"}', { status: 500 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': `req_fixture_${requests.length}` } });
  };
  return { client: new Anthropic({ apiKey: 'test-key-not-a-secret', fetch: fetchImpl, maxRetries: 0 }), requests };
}

describe('Anthropic adapter', () => {
  it('runs a recorded tool-call round trip: streamed thinking and text, a tool call, the result and the final answer', async () => {
    const { gate, lint } = await schemaContexts();
    const { client, requests } = replayClient([fixture('anthropic-tool-use.sse'), fixture('anthropic-end-turn.sse')]);
    const text: string[] = [];
    const thinking: string[] = [];
    const run = await runAgent({
      transport: anthropicTransport(client), route: 'anthropic', mode: 'explain', request: 'Where is the door fire rating?', doc: emptyDoc(), gate, lint,
      onEvent: (e) => { if (e.type === 'text') text.push(e.delta); if (e.type === 'thinking') thinking.push(e.delta); },
    });
    expect(run.status).toBe('completed');
    expect(run.proposal.summary).toBe('FireRating is in Pset_DoorCommon.');
    expect(text.join('')).toBe('Looking up door properties.FireRating is in Pset_DoorCommon.');
    expect(thinking.join('')).toContain('look the set up first');

    // The first request carries the Claude-first configuration.
    const [first, second] = requests;
    expect(first.url).toContain('/v1/messages');
    expect(first.headers.get('anthropic-beta')).toBe('task-budgets-2026-03-13,server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({
      model: 'claude-opus-5-5', stream: true, max_tokens: 8000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low', task_budget: { type: 'tokens', total: 20000 } },
      fallbacks: 'default', tool_choice: { type: 'auto' }, cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', cache_control: { type: 'ephemeral' } }],
    });
    const tools = first.body.tools as { name: string; strict?: boolean; eager_input_streaming?: boolean; input_schema: { type: string } }[];
    expect(tools.find((t) => t.name === 'schema_find_property')).toMatchObject({ strict: true, eager_input_streaming: true, input_schema: { type: 'object' } });
    expect(tools.some((t) => t.name === 'ids_apply_ops')).toBe(false);
    const firstMessages = first.body.messages as { role: string; content: { type: string; text?: string }[] }[];
    expect(firstMessages[0].content.map((c) => c.type)).toEqual(['text', 'text']);
    expect(firstMessages[0].content[0].text).toContain('Current IDS document');

    // The second request echoes the thinking block unchanged and answers the tool call.
    const messages = second.body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content[0]).toMatchObject({ type: 'thinking', signature: 'c2lnbmF0dXJlLWZpeHR1cmU=' });
    expect(messages[1].content[2]).toEqual({ type: 'tool_use', id: 'toolu_fixture_1', name: 'schema_find_property', input: { name: 'FireRating', version: 'IFC4', entity: 'IfcDoor' } });
    expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_fixture_1', is_error: false });
    expect(String(messages[2].content[0].content)).toContain('Pset_DoorCommon');

    // Usage comes from the provider (cache reads included in input), the served model from the message.
    expect(run.proposal.receipt.requests[0]).toMatchObject({ model: 'claude-opus-5-5', route: 'anthropic', usageReported: true, inputTokens: 10200, outputTokens: 85 });
  });

  it('maps a refusal with its category and explanation', async () => {
    const { gate, lint } = await schemaContexts();
    const { client } = replayClient([fixture('anthropic-refusal.sse')]);
    const run = await runAgent({ transport: anthropicTransport(client), mode: 'edit', request: 'x', doc: emptyDoc(), gate, lint });
    expect(run).toMatchObject({ status: 'refused', message: 'fixture refusal' });
  });

  it('can drop fallbacks, task budgets and eager streaming for other platforms or proxies', () => {
    const params = buildAnthropicParams({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, taskBudget: 5000,
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} }, strict: false }],
      signal: new AbortController().signal, onText: () => undefined, onThinking: () => undefined,
    }, { fallbacks: false, taskBudgets: false, eagerInputStreaming: false, thinkingDisplay: 'omitted' });
    expect(params).not.toHaveProperty('fallbacks');
    expect(params).not.toHaveProperty('betas');
    expect(params.output_config).toEqual({});
    expect(params.tools?.[0]).not.toHaveProperty('eager_input_streaming');
    expect(params.tools?.[0]).not.toHaveProperty('strict');
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('raises a task budget below the API minimum to 20k', () => {
    const params = buildAnthropicParams({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, taskBudget: 5000, tools: [],
      signal: new AbortController().signal, onText: () => undefined, onThinking: () => undefined,
    });
    expect(params.output_config).toEqual({ task_budget: { type: 'tokens', total: 20000 } });
  });

  it('surfaces an HTTP error as a run error', async () => {
    const { gate, lint } = await schemaContexts();
    const { client } = replayClient([]);
    const run = await runAgent({ transport: anthropicTransport(client), mode: 'edit', request: 'x', doc: emptyDoc(), gate, lint });
    expect(run.status).toBe('error');
  });
});
