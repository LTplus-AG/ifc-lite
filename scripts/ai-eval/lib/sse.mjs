/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider SSE decoding for the AI evaluation tools (#6928). A recording keeps
 * the provider's `data:` payloads verbatim (as parsed JSON); this folds them
 * into the answer text, finish reason and reported usage the same way the
 * viewer's stream clients do, for the three routes the viewer has:
 *
 *   proxy / openai — Chat Completions chunks (`choices[].delta.content`,
 *                    `finish_reason`, a trailing `usage` chunk when the
 *                    upstream sends one); the proxy's `__ifcLiteUsage` quota
 *                    event is ignored.
 *   anthropic      — Messages events (`content_block_delta`, `message_start`
 *                    and `message_delta` usage, `stop_reason`).
 *
 * Usage is reported only when the stream carried it; nothing is estimated.
 */

/** Split SSE wire text into `data:` payload strings, skipping `[DONE]`. */
export function sseData(text) {
  const out = [];
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const lines = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
    if (lines.length && lines.join('\n') !== '[DONE]') out.push(lines.join('\n'));
  }
  return out;
}

/** Parse payload strings into events; a non-JSON payload is kept as `{ unparsed }` so nothing is lost. */
export function parseEvents(payloads) {
  return payloads.map(data => {
    try { return JSON.parse(data); }
    catch { return { unparsed: data }; }
  });
}

/**
 * Fold recorded events into `{ text, finishReason, usage }`. `usage` is
 * `{ inputTokens, outputTokens }` or null when the provider reported none.
 */
export function foldEvents(route, events) {
  let text = '';
  let finishReason = null;
  let inputTokens = null;
  let outputTokens = null;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (route === 'anthropic') {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text ?? '';
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? inputTokens;
        outputTokens = event.message.usage.output_tokens ?? outputTokens;
      }
      if (event.type === 'message_delta') {
        finishReason = event.delta?.stop_reason ?? finishReason;
        if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
      }
      continue;
    }
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
    if (event.usage && typeof event.usage === 'object') {
      inputTokens = event.usage.prompt_tokens ?? inputTokens;
      outputTokens = event.usage.completion_tokens ?? outputTokens;
    }
  }
  const usage = outputTokens === null && inputTokens === null ? null : { inputTokens, outputTokens };
  return { text, finishReason, usage };
}

const TRUNCATION = new Set(['length', 'max_tokens']);

/** The viewer's typed outcome for a folded stream (request-service.ts semantics). */
export function outcomeOf(status, folded) {
  if (status !== 200) return 'error';
  if (!folded.text.trim()) return 'error';
  return folded.finishReason && TRUNCATION.has(folded.finishReason) ? 'truncated' : 'completed';
}
