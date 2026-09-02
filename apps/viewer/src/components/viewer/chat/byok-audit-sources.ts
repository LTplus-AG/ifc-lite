/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The source files the BYOK modal invites you to read, relative to
 * `apps/viewer/src`.
 *
 * Their own module, with no runtime imports, for two reasons. The modal renders
 * them into a github.com/blob/main link, so a rename turns its central trust
 * claim into a 404 — and a test can only catch that if it reads the same values
 * the modal does. Scanning the modal's source text for path-shaped strings
 * looks equivalent and is not: the regex, not the modal, then decides what
 * counts, so writing a path as a template literal drops it from the check
 * silently. Importing this costs the test nothing, which is why there are no
 * value imports here.
 */

import type { BYOKProvider } from '@/lib/llm/clipboard-detect';

/** Where a BYOK key is sent from unless the surface says otherwise. */
export const DEFAULT_REQUEST_SOURCE = 'lib/llm/stream-direct.ts';

/**
 * Files a provider's key passes through before the request is built. The file
 * that sends it is per-surface, so it is not listed here.
 */
export const CLIENT_FILES: Record<BYOKProvider, string[]> = {
  anthropic: ['lib/llm/anthropic-client.ts'],
  openai: [],
};

/**
 * The MCP playground drives its own Anthropic loop and never reaches
 * `stream-direct.ts`, while issuing no OpenAI request at all — so its OpenAI
 * tab keeps the default.
 */
export const PLAYGROUND_REQUEST_SOURCE: Partial<Record<BYOKProvider, string>> = {
  anthropic: 'components/mcp/PlaygroundChat.tsx',
};

/** Every path the modal can link to, for the existence check. */
export function allAuditSources(): string[] {
  return [
    ...Object.values(CLIENT_FILES).flat(),
    DEFAULT_REQUEST_SOURCE,
    ...Object.values(PLAYGROUND_REQUEST_SOURCE).filter((p): p is string => Boolean(p)),
  ];
}
