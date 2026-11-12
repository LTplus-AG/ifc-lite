/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A main-viewer tool outcome as the bridge's `result` frame (#9523).
 *
 * The agent must not be able to tell the bridge from the stdio server, so the
 * shapes follow `@ifc-lite/mcp`'s own helpers: a success is `okResult`
 * (one text block, `structuredContent` when the value is an object), and a
 * failure is `toolError` (`structuredContent: { code, message, details,
 * hint }`, `isError: true`).
 *
 * A frame larger than the bridge accepts would close the socket, so an
 * oversize result is cut down here instead, with a note telling the agent
 * what happened and how to ask for less.
 */

import { BRIDGE_LIMITS, type BridgeCallResult, type BridgeResultMessage } from '@ifc-lite/mcp/bridge-protocol';

/** A tool outcome, as `dispatchMainViewerTool` returns it. */
export interface ToolOutcome {
  text: string;
  structured: unknown;
  isError: boolean;
  errorCode?: string;
  hint?: string;
}

/** Room left in a frame for the envelope, the note and JSON escaping slack. */
const ENVELOPE_RESERVE_BYTES = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The MCP `CallToolResult` the stdio server would have returned for this outcome. */
export function toCallToolResult(outcome: ToolOutcome): BridgeCallResult {
  const content = [{ type: 'text', text: outcome.text }];
  if (outcome.isError) {
    return {
      content,
      structuredContent: {
        code: outcome.errorCode ?? 'INTERNAL_ERROR',
        message: outcome.text,
        details: isPlainObject(outcome.structured) ? outcome.structured : {},
        ...(outcome.hint !== undefined ? { hint: outcome.hint } : {}),
      },
      isError: true,
    };
  }
  return isPlainObject(outcome.structured) ? { content, structuredContent: outcome.structured } : { content };
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** The first `maxBytes` UTF-8 bytes of `text`, never ending inside a character. */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Back up to a character boundary: continuation bytes are 0b10xxxxxx.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export interface ResultFrame {
  /** The serialised `result` frame, at most `maxBytes` UTF-8 bytes. */
  json: string;
  truncated: boolean;
}

/**
 * Serialise the `result` frame for call `id`, cutting the result down to fit
 * `maxBytes` when it would not. A cut result keeps `isError` and, for an
 * error, its code; it drops `structuredContent` (which cannot be cut without
 * becoming wrong) and keeps as much text as fits, followed by a note.
 */
export function buildResultFrame(
  sessionId: string,
  id: string,
  result: BridgeCallResult,
  maxBytes: number = BRIDGE_LIMITS.maxMessageBytes,
): ResultFrame {
  const frame = (r: BridgeCallResult): string =>
    JSON.stringify({ type: 'result', sessionId, id, result: r } satisfies BridgeResultMessage);
  const full = frame(result);
  const fullBytes = byteLength(full);
  if (fullBytes <= maxBytes) return { json: full, truncated: false };

  const text = result.content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n');
  const note = `\n\n[Truncated by the viewer: the full result was ${fullBytes} bytes, over the bridge's `
    + `${maxBytes}-byte message limit. Ask for less: a smaller limit, fewer fields, or one model_id.]`;
  const code = isPlainObject(result.structuredContent) && typeof result.structuredContent.code === 'string'
    ? result.structuredContent.code : undefined;
  const marker = { truncated: true, originalBytes: fullBytes, limitBytes: maxBytes, ...(code ? { code } : {}) };
  // JSON escaping can grow text (quotes, control characters), so shrink the
  // budget until the frame fits rather than trusting one estimate.
  let budget = Math.max(0, maxBytes - ENVELOPE_RESERVE_BYTES);
  for (;;) {
    const cut: BridgeCallResult = {
      content: [{ type: 'text', text: utf8Prefix(text, budget) + note }],
      structuredContent: marker,
      ...(result.isError ? { isError: true } : {}),
    };
    const json = frame(cut);
    if (byteLength(json) <= maxBytes || budget === 0) return { json, truncated: true };
    budget = Math.floor(budget / 2);
  }
}
