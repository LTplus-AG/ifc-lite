/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure routing guard for chat streams.
 *
 * Given a model id and the current BYOK key bag, decide whether the send
 * should go through the proxy, direct to a provider, or be blocked because
 * a required key is missing. Pulled out of ChatPanel so we can unit-test
 * the guard without spinning up React — and so the "missing key" check
 * happens BEFORE the user message is appended to the chat history.
 */

import { getModelById } from './models.js';
import type { AnthropicCredentials } from './anthropic-client.js';
import type { ApiKeyConfig } from '../../services/api-keys.js';

export type StreamRoute =
  | { kind: 'proxy'; model: string }
  | { kind: 'anthropic'; model: string; credentials: AnthropicCredentials }
  | { kind: 'openai'; model: string; apiKey: string }
  | { kind: 'missing-key'; provider: 'anthropic' | 'openai' };

export function resolveStreamRoute(modelId: string, keys: ApiKeyConfig): StreamRoute {
  const model = getModelById(modelId);
  const source = model?.source ?? 'proxy';

  if (source === 'anthropic') {
    const apiKey = keys.anthropicKey.trim();
    if (!apiKey) return { kind: 'missing-key', provider: 'anthropic' };
    // The workspace id rides with the key — see `anthropic-client.ts`.
    return {
      kind: 'anthropic',
      model: modelId,
      credentials: { apiKey, workspaceId: keys.anthropicWorkspaceId.trim() },
    };
  }
  if (source === 'openai') {
    const apiKey = keys.openaiKey.trim();
    if (!apiKey) return { kind: 'missing-key', provider: 'openai' };
    return { kind: 'openai', model: modelId, apiKey };
  }
  return { kind: 'proxy', model: modelId };
}
