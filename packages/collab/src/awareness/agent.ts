/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Agent / service-account presence helper (spec §16.4 — v0.6 prep).
 *
 * AI agents are first-class peers. The viewer needs to render them
 * differently (distinct avatar style, a "(agent)" suffix, a slightly
 * different color band) so humans always know which edits came from a
 * model and which from a person.
 *
 * The wire shape stays the same `PresenceState`; we just standardize
 * the convention here so every consumer agrees.
 */

import type { Presence, UserIdentity } from './presence.js';

export interface AgentIdentity extends UserIdentity {
  /** Tool that the agent is operating through, e.g. 'mcp:claude-3.5'. */
  agentTool?: string;
  /** Tool invocation ID (for audit log correlation). */
  invocationId?: string;
}

/** Agent palette is intentionally darker / desaturated vs. human users. */
export const AGENT_PALETTE: readonly string[] = [
  '#6b7d99',
  '#7a6b99',
  '#996b8e',
  '#998b6b',
  '#6b9988',
] as const;

/**
 * Mark a presence stream as authored by an agent. The viewer picks up
 * `tool: 'edit'`, the `(agent)` suffix on `name`, and `meta.agent === true`
 * (stored on `presence.user`) to render the distinct avatar style.
 */
export function markAsAgent(presence: Presence, identity: AgentIdentity): void {
  const normalized: UserIdentity = {
    ...identity,
    name: identity.name.endsWith('(agent)') ? identity.name : `${identity.name} (agent)`,
  };
  presence.setUser(normalized);
  presence.setTool('edit');
  presence.patch({ status: 'active' });
}

/**
 * Convenience: produce an `AgentIdentity` from an MCP tool invocation.
 * Caller must still pass it to `markAsAgent(presence, identity)`.
 */
export function agentIdentityFromMcp(input: {
  toolName: string;
  invocationId?: string;
  modelHint?: string;
}): AgentIdentity {
  const id = `agent:${input.toolName}:${input.invocationId ?? 'live'}`;
  return {
    id,
    name: input.modelHint ?? input.toolName,
    agentTool: input.toolName,
    invocationId: input.invocationId,
  };
}
