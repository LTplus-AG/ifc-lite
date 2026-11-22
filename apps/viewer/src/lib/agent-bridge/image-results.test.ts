/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Image results over the bridge: sent as image blocks only to a bridge whose
 * `welcome` listed `image-content`, replaced by an update note for an older
 * bridge, and dropped (with a note) before text when a result is too large.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_PROTOCOL_VERSION, parseTabMessage, type BridgeCallResult, type BridgeResultMessage,
} from '@ifc-lite/mcp/bridge-protocol';
import { BridgeClient, type WebSocketLike } from './client';
import { IMAGE_NEEDS_NEWER_BRIDGE, buildResultFrame, toCallToolResult, type ToolOutcome } from './result-frame';

const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1));
const SHOT: ToolOutcome = { text: 'Viewport screenshot, 2x1', structured: { width: 2, height: 1 }, isError: false, image: { data: JPEG, mimeType: 'image/jpeg' } };

class Socket implements WebSocketLike {
  static last: Socket | null = null;
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  readonly sent: string[] = [];
  constructor() { Socket.last = this; }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
}

async function resultFor(welcomeExtra: Record<string, unknown>): Promise<BridgeCallResult> {
  const client = new BridgeClient({
    port: 21517, pairingCode: 'abcde-fghjk-mnpqr-stvwx', tools: [], WebSocket: Socket, lifecycle: null,
    dispatch: async () => SHOT, onStatus: () => {},
  });
  client.connect();
  const socket = Socket.last;
  assert.ok(socket);
  socket.readyState = 1;
  socket.onopen?.({});
  const frame = (msg: unknown) => socket.onmessage?.({ data: JSON.stringify(msg) });
  frame({ type: 'welcome', protocol: BRIDGE_PROTOCOL_VERSION, sessionId: 's1', permission: 'read-only', readOnlyCeiling: false, bridge: { name: 'b', version: '1' }, ...welcomeExtra });
  frame({ type: 'call', sessionId: 's1', id: 'c1', name: 'viewer_screenshot', arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.disconnect();
  const parsed = parseTabMessage(socket.sent[1]);
  assert.ok(parsed.ok && parsed.value.type === 'result', 'the bridge validator accepts the frame');
  return (parsed.value as BridgeResultMessage).result;
}

describe('image results and the welcome feature list', () => {
  it('sends the image as an image block when the bridge advertised image-content', async () => {
    const result = await resultFor({ features: ['image-content'] });
    assert.deepEqual(result.content, [{ type: 'text', text: SHOT.text }, { type: 'image', data: JPEG, mimeType: 'image/jpeg' }]);
  });

  it('omits the image and says to update the bridge when the welcome has no features (an older bridge)', async () => {
    for (const extra of [{}, { features: ['something-else'] }]) {
      const result = await resultFor(extra);
      assert.deepEqual(result.content, [{ type: 'text', text: SHOT.text }, { type: 'text', text: IMAGE_NEEDS_NEWER_BRIDGE }]);
      assert.match(IMAGE_NEEDS_NEWER_BRIDGE, /npx @ifc-lite\/mcp@latest --bridge/);
    }
  });

  it('never attaches an image to an error result', () => {
    const result = toCallToolResult({ ...SHOT, isError: true, errorCode: 'INTERNAL_ERROR' }, true);
    assert.deepEqual(result.content, [{ type: 'text', text: SHOT.text }]);
  });
});

describe('truncating a result that carries an image', () => {
  const big = (chars: number): ToolOutcome => ({ ...SHOT, image: { data: JPEG + 'A'.repeat(chars - JPEG.length), mimeType: 'image/jpeg' } });

  it('drops the image with a note and keeps the text and structured content', () => {
    const frame = buildResultFrame('s', 'c', toCallToolResult(big(20_000), true), 10_000, false, true);
    assert.equal(frame.truncated, true);
    const parsed = parseTabMessage(frame.json);
    assert.ok(parsed.ok && parsed.value.type === 'result');
    const { result, resultAck } = parsed.value as BridgeResultMessage;
    assert.equal(resultAck, undefined, 'a truncated result does not request an acknowledgement');
    assert.equal(result.content.some((block) => block.type === 'image'), false);
    assert.equal(result.content[0].type === 'text' && result.content[0].text, SHOT.text);
    assert.match(result.content[1].type === 'text' ? result.content[1].text : '', /dropped 1 image\(s\)/);
    assert.deepEqual(result.structuredContent, SHOT.structured);
  });

  it('also cuts the text when it does not fit without the image either', () => {
    const outcome = { ...big(20_000), text: 'x'.repeat(30_000) };
    const frame = buildResultFrame('s', 'c', toCallToolResult(outcome, true), 10_000);
    const parsed = parseTabMessage(frame.json);
    assert.ok(parsed.ok && parsed.value.type === 'result');
    const { result } = parsed.value as BridgeResultMessage;
    assert.equal(frame.truncated, true);
    assert.deepEqual(result.content.map((block) => block.type), ['text']);
    assert.match(result.content[0].type === 'text' ? result.content[0].text : '', /1 image\(s\) were dropped/);
    assert.equal((result.structuredContent as { truncated?: boolean }).truncated, true);
  });

  it('retains acknowledgement and activity digest without counting envelope bytes against the result', () => {
    const result = toCallToolResult({ ...SHOT, image: undefined }, true);
    const limit = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    const plain = buildResultFrame('session', 'call', result, limit, true);
    const acknowledged = buildResultFrame('session', 'call', result, limit, true, true);
    const parsed = parseTabMessage(acknowledged.json);
    assert.ok(parsed.ok && parsed.value.type === 'result');
    assert.equal(parsed.value.resultAck, true);
    assert.equal(acknowledged.truncated, false);
    assert.ok(plain.resultDigest);
    assert.equal(acknowledged.resultDigest, plain.resultDigest);
  });

  it('leaves a result that fits unchanged', () => {
    const frame = buildResultFrame('s', 'c', toCallToolResult(SHOT, true));
    assert.equal(frame.truncated, false);
    assert.match(frame.json, /"type":"image"/);
  });
});
