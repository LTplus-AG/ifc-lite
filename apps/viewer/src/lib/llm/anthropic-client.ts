/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a browser-side Anthropic client is constructed.
 *
 * An Anthropic credential is a pair, not a string. Keys created against a
 * single workspace carry that binding themselves, but an identity-linked key
 * (a personal or service-account key with access to more than one workspace)
 * does not: the API cannot tell which workspace to act in, so it rejects every
 * request with a 400 until the caller names one in an `anthropic-workspace-id`
 * header. The SDK sends auth, version and content-type on its own; this header
 * is ours to send.
 *
 * Modelling the credential as a bare `apiKey` string is what made that a bug
 * rather than a setting: each call site had to remember a header it could not
 * see in the type. So the pair travels together and the header is applied
 * here, where no call site can forget it.
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';

export interface AnthropicCredentials {
  apiKey: string;
  /**
   * `wrkspc_…` id of the workspace requests act in. Empty for the common case
   * of a key already scoped to one workspace, where the header is not needed
   * and sending it would be wrong.
   */
  workspaceId: string;
}

/**
 * Is this workspace id plain printable ASCII?
 *
 * Deliberately stricter than "can be sent". Header values are ByteStrings, so
 * only characters above U+00FF actually throw while the request is built — a
 * non-breaking space (U+00A0) would go out fine. But everything this rejects
 * beyond that boundary is a paste artifact rather than a plausible id: a
 * zero-width space, an NBSP, a curly quote, all of which survive a copy out of
 * a console UI where a newline would not. Naming the cause here beats either a
 * `TypeError` about ByteStrings and a character index — thrown before any HTTP
 * call, mentioning no field — or a server 400 for an id that looks correct.
 * Control characters are rejected too: a CR or LF in a header value is header
 * injection, not a typo.
 *
 * It still says nothing about Anthropic's id FORMAT. A clean but wrong id earns
 * the 400 that `anthropicErrorMessage` explains, because guessing the format
 * would reject ids the API may yet start issuing.
 */
export function isPlainAsciiWorkspaceId(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value.trim());
}

export function createAnthropicClient(credentials: AnthropicCredentials): Anthropic {
  const workspaceId = credentials.workspaceId.trim();
  if (!isPlainAsciiWorkspaceId(workspaceId)) {
    throw new Error(
      'The Workspace ID in Settings contains a character that does not belong in one — '
      + 'usually an invisible one picked up while copying. Retype it or paste it again.',
    );
  }
  return new Anthropic({
    apiKey: credentials.apiKey,
    dangerouslyAllowBrowser: true,
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
  });
}

/**
 * True when a 400 is about the workspace header at all.
 *
 * The API returns a plain `invalid_request_error` with no machine-readable
 * code, so the header name in the message is the only discriminator on offer.
 * A miss falls through to the generic message below — the same text this code
 * showed before — rather than to anything worse.
 */
function isWorkspaceIdError(err: APIError): boolean {
  if (err.status !== 400) return false;
  // Two narrowings, and both are load-bearing.
  //
  // Read the body's own message field, NOT `err.message`: the SDK builds that
  // by stringifying the whole body, so it also matches a 400 quoting the header
  // name in some other field. Do not "simplify" this back to `err.message` —
  // the two read the same characters and only this one knows where they are.
  //
  // Then require the message to START with the header name. Both messages
  // Anthropic actually sends do ("… is required when authenticating …", "…
  // header must be a valid workspace ID."), while a message that merely quotes
  // the name is about something else — a rejected tool schema, say, and the MCP
  // playground forwards tool definitions it did not write. Matching those would
  // bury an actionable error under a dead end pointing at a field that is fine.
  //
  // A rephrasing that buries the name mid-sentence would be missed, and would
  // fall through to the generic message — visibly worse wording, which is what
  // shipped before this change, not a silent wrong answer.
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' && /^\s*anthropic-workspace-id\b/i.test(message);
}

/**
 * Turn a failed Anthropic request into something a user can act on. Shared by
 * the chat stream and the MCP playground so both explain the same failure the
 * same way. `workspaceId` is the one the request carried, empty if it carried
 * none — see the workspace branch for why that decides the wording.
 */
export function anthropicErrorMessage(err: unknown, workspaceId: string): string {
  if (err instanceof APIError) {
    if (err.status === 401) return 'Invalid Anthropic API key. Check your key in Settings.';
    if (err.status === 429) return 'Anthropic rate limit reached. Please wait and try again.';
    if (isWorkspaceIdError(err)) {
      // Two different 400s name this header — one for a missing id, one for an
      // id the API cannot resolve — and telling a user to add an id they have
      // already added is a dead end. Which one it is follows from what we sent,
      // so read that rather than a second phrase in Anthropic's message.
      return workspaceId.trim()
        ? 'Anthropic rejected the Workspace ID in Settings. Copy it from the Anthropic console '
          + '(Settings → Workspaces), or clear the field if your key is already scoped to a '
          + 'single workspace.'
        : 'This Anthropic key works across several workspaces, so each request has to name one. '
          + 'Add the workspace id (Settings → Anthropic → Workspace ID), or create a key scoped to a '
          + 'single workspace in the Anthropic console.';
    }
    // A network failure or an abort is an APIError with no status, and
    // `Anthropic error (undefined)` is worse than the SDK's own wording.
    if (typeof err.status !== 'number') return err.message;
    return `Anthropic error (${err.status}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
