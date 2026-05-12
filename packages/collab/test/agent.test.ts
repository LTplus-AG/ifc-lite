/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createPresence } from '../src/awareness/presence.js';
import { agentIdentityFromMcp, markAsAgent } from '../src/awareness/agent.js';

describe('agent presence helper', () => {
  it('markAsAgent suffixes the name and sets the edit tool', () => {
    const doc = createCollabDoc();
    const presence = createPresence(doc, { updateRateHz: 1000 });
    markAsAgent(presence, agentIdentityFromMcp({ toolName: 'mcp:claude', invocationId: 'inv-1' }));
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const self = presence.getSelf();
        expect(self?.user.name.endsWith('(agent)')).toBe(true);
        expect(self?.tool).toBe('edit');
        expect(self?.user.color).toBeTypeOf('string');
        presence.dispose();
        resolve();
      }, 30);
    });
  });

  it('agentIdentityFromMcp produces a stable id', () => {
    const a = agentIdentityFromMcp({ toolName: 'mcp:claude', invocationId: 'x' });
    const b = agentIdentityFromMcp({ toolName: 'mcp:claude', invocationId: 'x' });
    expect(a.id).toBe(b.id);
  });

  it('markAsAgent does not double-suffix when called twice', () => {
    const doc = createCollabDoc();
    const presence = createPresence(doc, { updateRateHz: 1000 });
    const id = agentIdentityFromMcp({ toolName: 'mcp:claude' });
    markAsAgent(presence, id);
    markAsAgent(presence, id);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const self = presence.getSelf();
        expect(self?.user.name.match(/\(agent\)/g)?.length ?? 0).toBe(1);
        presence.dispose();
        resolve();
      }, 30);
    });
  });
});
