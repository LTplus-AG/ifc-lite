/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only Anthropic Messages event streams: a scripted model answer in the
 * documented SSE wire format, served through a replaced `fetch`. No live
 * call and no key are involved.
 */

export type ScriptedBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** One streamed message whose content is `blocks`. */
export function anthropicStream(blocks: readonly ScriptedBlock[], stopReason: 'end_turn' | 'tool_use' = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'): string {
  const usage = { input_tokens: 500, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let out = event('message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [], stop_reason: null, stop_sequence: null, stop_details: null, usage } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out += event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      out += event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      out += event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    out += event('content_block_stop', { type: 'content_block_stop', index });
  });
  out += event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null }, usage: { ...usage, output_tokens: 40 } });
  return out + event('message_stop', { type: 'message_stop' });
}

/** Replace `fetch` with one that answers each request with the next stream; records the request bodies. */
export function serveAnthropicStreams(streams: readonly string[]): { bodies: Record<string, unknown>[]; restore: () => void } {
  const original = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = streams[bodies.length - 1];
    if (body === undefined) return new Response('{"type":"error","error":{"type":"api_error","message":"script exhausted"}}', { status: 500 });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}
