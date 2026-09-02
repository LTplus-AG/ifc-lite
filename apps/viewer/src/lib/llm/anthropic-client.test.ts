/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The header assertions here drive a real request through a stubbed `fetch`
 * and read what actually went out, rather than inspecting constructor options.
 * Whether `defaultHeaders` reaches the wire is the entire claim; an assertion
 * on the object we passed in would hold even if the SDK ignored it.
 *
 * The error-mapping tests likewise let the SDK build the error from a real
 * response body. Hand-rolling an `APIError` would test our guess at the
 * message shape, which is the one thing the mapper depends on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { captureFetch, jsonResponse } from '@/test/fetch-stub.js';
import {
  anthropicErrorMessage,
  createAnthropicClient,
  isPlainAsciiWorkspaceId,
} from './anthropic-client.js';

/**
 * Verbatim bodies the API returns, both observed against api.anthropic.com.
 * They are different failures — no id sent, versus an id it cannot resolve —
 * and both name the header, which is why the mapper cannot tell them apart
 * from the message alone.
 */
const MISSING_WORKSPACE_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      'anthropic-workspace-id is required when authenticating with an identity-linked API key; '
      + 'send the id of the workspace this request acts in.',
  },
  request_id: null,
};

const INVALID_WORKSPACE_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'anthropic-workspace-id header must be a valid workspace ID.',
  },
  request_id: null,
};

function okMessageResponse(): Response {
  return jsonResponse({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/**
 * Send one request through a client built for `workspaceId`, and report the
 * headers that actually went out plus whatever the call threw.
 *
 * The fetch stub is installed before the client is constructed, because the
 * SDK may capture `fetch` at construction time.
 */
async function sendOnce(workspaceId: string, respond: () => Response): Promise<{
  headers: Headers;
  attempts: number;
  error: unknown;
}> {
  const captured = captureFetch(respond);
  let error: unknown = null;
  try {
    await createAnthropicClient({ apiKey: 'sk-ant-test', workspaceId }).messages.create({
      model: 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (err) {
    error = err;
  } finally {
    captured.restore();
  }
  // Retryable outcomes (429, 5xx, connection errors) send more than one attempt;
  // the headers are identical across them, so the first is the one to read.
  assert.ok(captured.sent.length >= 1, 'expected at least one request');
  return { headers: captured.sent[0], attempts: captured.sent.length, error };
}

test('createAnthropicClient sends anthropic-workspace-id when a workspace is configured', async () => {
  const { headers, attempts } = await sendOnce('wrkspc_01abc', okMessageResponse);
  assert.equal(attempts, 1, 'a 200 must not be retried');
  assert.equal(headers.get('anthropic-workspace-id'), 'wrkspc_01abc');
});

test('createAnthropicClient trims the workspace id before sending it', async () => {
  const { headers } = await sendOnce('  wrkspc_01abc\n', okMessageResponse);
  assert.equal(headers.get('anthropic-workspace-id'), 'wrkspc_01abc');
});

test('createAnthropicClient omits the header entirely when no workspace is configured', async () => {
  // Not "sends an empty value" — a blank header is itself a 400 on a key that
  // is already scoped to one workspace, which is the common case.
  const { headers } = await sendOnce('', okMessageResponse);
  assert.equal(headers.has('anthropic-workspace-id'), false);
});

test('createAnthropicClient omits the header when the workspace id is whitespace', async () => {
  const { headers } = await sendOnce('   ', okMessageResponse);
  assert.equal(headers.has('anthropic-workspace-id'), false);
});

test('a workspace id carrying a paste artifact is refused before the request', () => {
  // U+200B is the case that matters: a zero-width space survives a paste out of
  // a console UI and out of a single-line input, and reaches the request
  // builder, which throws about ByteStrings and a character index — nothing
  // that points at the field it came from.
  assert.equal(isPlainAsciiWorkspaceId('wrkspc_\u200Babc'), false, 'zero-width space');
  assert.equal(isPlainAsciiWorkspaceId('wrkspc_\u201Cabc\u201D'), false, 'curly quotes');
  assert.equal(isPlainAsciiWorkspaceId('wrkspc_abc\r\nX-Injected: 1'), false, 'header injection');
  // Deliberately stricter than header-sendability: U+00A0 would go out fine
  // (only above U+00FF throws), but an NBSP in an id is a paste artifact, and
  // saying so here beats a server 400 for an id that looks correct.
  assert.equal(isPlainAsciiWorkspaceId('wrkspc_\u00A0abc'), false, 'sendable, still wrong');

  assert.equal(isPlainAsciiWorkspaceId('wrkspc_01abc'), true);
  assert.equal(isPlainAsciiWorkspaceId(''), true, 'no id at all is fine');
  // Clean but wrong is NOT this function's business: it still earns the 400
  // the mapper explains, so the check cannot start guessing Anthropic's format.
  assert.equal(isPlainAsciiWorkspaceId('not even close'), true);

  assert.throws(
    () => createAnthropicClient({ apiKey: 'sk-ant-test', workspaceId: 'wrkspc_\u200Babc' }),
    /does not belong in one/,
  );
});

test('anthropicErrorMessage asks for a workspace id when none was sent', async () => {
  const { error } = await sendOnce('', () => jsonResponse(MISSING_WORKSPACE_BODY, 400));
  assert.ok(error, 'expected the 400 to throw');
  const message = anthropicErrorMessage(error, '');
  assert.match(message, /several workspaces/);
  assert.match(message, /Workspace ID/);
  assert.doesNotMatch(message, /invalid_request_error/);
});

test('anthropicErrorMessage says the stored workspace id is wrong when one was sent', async () => {
  // Same header, different failure. Repeating "add a workspace id" to someone
  // who already added one sends them nowhere.
  const { error } = await sendOnce('wrkspc_typo', () => jsonResponse(INVALID_WORKSPACE_BODY, 400));
  const message = anthropicErrorMessage(error, 'wrkspc_typo');
  assert.match(message, /rejected the Workspace ID/);
  assert.doesNotMatch(message, /several workspaces/);
  // The field is optional and shown to everyone, so a wrong id may be one that
  // should not be there at all. Re-copying is not the only remedy.
  assert.match(message, /clear the field/);
});

test('the branch follows what was sent, not Anthropic\'s wording', async () => {
  // Swap the two bodies between the two cases: the message must follow the
  // credential, so neither phrase can be what is really being matched.
  const sentNone = await sendOnce('', () => jsonResponse(INVALID_WORKSPACE_BODY, 400));
  assert.match(
    anthropicErrorMessage(sentNone.error, ''),
    /several workspaces/,
  );
  const sentOne = await sendOnce('wrkspc_01abc', () => jsonResponse(MISSING_WORKSPACE_BODY, 400));
  assert.match(
    anthropicErrorMessage(sentOne.error, 'wrkspc_01abc'),
    /rejected the Workspace ID/,
  );
});

test('a 400 that merely quotes the header name elsewhere is left alone', async () => {
  // The MCP playground forwards tool definitions it did not write, so a
  // rejected schema can echo arbitrary text back inside the error body.
  // Matching the whole serialised body would rewrite this into "check your
  // Workspace ID" and bury the thing the user can act on.
  const { error } = await sendOnce('', () => jsonResponse({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'tools.0.input_schema: unexpected property "anthropic-workspace-id"',
    },
  }, 400));
  const message = anthropicErrorMessage(error, '');
  assert.match(message, /input_schema/);
  assert.doesNotMatch(message, /several workspaces/);
  assert.doesNotMatch(message, /rejected the Workspace ID/);
});

test('only a 400 is read as a workspace problem', async () => {
  // The status guard was never exercised, and a 401 cannot exercise it: that
  // branch returns first. A 403 reaches it, and a permission failure that
  // happens to name the header must stay a permission failure — otherwise it is
  // reported as a Settings problem the user cannot fix.
  const { error } = await sendOnce('', () => jsonResponse({
    type: 'error',
    error: { type: 'permission_error', message: 'anthropic-workspace-id names a workspace you cannot access' },
  }, 403));
  const message = anthropicErrorMessage(error, '');
  assert.match(message, /^Anthropic error \(403\):/);
  assert.doesNotMatch(message, /several workspaces/);
  assert.doesNotMatch(message, /rejected the Workspace ID/);
});

test('anthropicErrorMessage leaves an unrelated 400 on the generic path', async () => {
  const { error } = await sendOnce('', () => jsonResponse({
    type: 'error',
    error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' },
  }, 400));
  const message = anthropicErrorMessage(error, '');
  assert.match(message, /^Anthropic error \(400\):/);
  assert.match(message, /max_tokens/);
});

test('anthropicErrorMessage keeps the invalid-key message', async () => {
  const unauthorized = await sendOnce('', () => jsonResponse(
    { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    401,
  ));
  assert.equal(
    anthropicErrorMessage(unauthorized.error, ''),
    'Invalid Anthropic API key. Check your key in Settings.',
  );
});

test('anthropicErrorMessage keeps the rate-limit message', async () => {
  // Its own test: folded into the 401 case, deleting the 429 branch left the
  // whole file green while the name still claimed to cover it.
  const limited = await sendOnce('', () => jsonResponse(
    { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
    429,
  ));
  assert.equal(
    anthropicErrorMessage(limited.error, ''),
    'Anthropic rate limit reached. Please wait and try again.',
  );
});

test('a failure with no status keeps the SDK wording instead of "(undefined)"', async () => {
  // Connection errors and aborts are APIErrors with `status === undefined`.
  const { error } = await sendOnce('', () => { throw new TypeError('Failed to fetch'); });
  const message = anthropicErrorMessage(error, '');
  assert.doesNotMatch(message, /undefined/);
  assert.match(message, /[Cc]onnection error/);
});

test('anthropicErrorMessage passes through non-API errors', () => {
  const creds = '';
  assert.equal(anthropicErrorMessage(new Error('network down'), creds), 'network down');
  assert.equal(anthropicErrorMessage('plain string', creds), 'plain string');
});
