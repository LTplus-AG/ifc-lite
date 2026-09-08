/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BYOK API key storage had no test at all. Real logic worth pinning:
 *  - `sanitize` trims and type-guards whatever localStorage returns, so a
 *    corrupted/foreign value degrades to empty strings rather than throwing
 *    or leaking a non-string into the rest of the app.
 *  - `hasAnyApiKey` is an OR across the two providers: either key alone
 *    must be enough.
 *  - `updateApiKeys` merges onto the existing config (a caller updating
 *    just one key must not clobber the other).
 */

import '../test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { posthog } from '../lib/analytics.js';
import {
  getApiKeys,
  updateApiKeys,
  clearApiKeys,
  clearProvider,
  saveCredential,
  hasAnthropicKey,
  hasOpenaiKey,
  hasAnyApiKey,
} from './api-keys.js';

describe('api-keys', () => {
  beforeEach(() => {
    clearApiKeys();
  });

  it('returns an empty config when nothing is stored', () => {
    assert.deepEqual(getApiKeys(), { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
  });

  it('trims whitespace on save', () => {
    updateApiKeys({ anthropicKey: '  sk-ant-abc  ' });
    assert.equal(getApiKeys().anthropicKey, 'sk-ant-abc');
  });

  it('updating one key preserves the other', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    updateApiKeys({ openaiKey: 'sk-oai-xyz' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: '',
      openaiKey: 'sk-oai-xyz',
    });
  });

  it('sanitizes a corrupted stored value back to empty strings instead of throwing', () => {
    localStorage.setItem(
      'ifc-lite:api-keys:v1',
      JSON.stringify({ anthropicKey: 42, anthropicWorkspaceId: [], openaiKey: null }),
    );
    assert.deepEqual(getApiKeys(), { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
  });

  it('sanitizes non-JSON stored garbage to the empty config', () => {
    localStorage.setItem('ifc-lite:api-keys:v1', 'not json');
    assert.deepEqual(getApiKeys(), { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
  });

  it('hasAnthropicKey / hasOpenaiKey reflect only their own provider', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    assert.equal(hasAnthropicKey(), true);
    assert.equal(hasOpenaiKey(), false);
  });

  it('hasAnyApiKey is true when only the anthropic key is set', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    assert.equal(hasAnyApiKey(), true);
  });

  it('hasAnyApiKey is true when only the openai key is set', () => {
    updateApiKeys({ openaiKey: 'sk-oai-xyz' });
    assert.equal(hasAnyApiKey(), true);
  });

  it('hasAnyApiKey is false when neither key is set', () => {
    assert.equal(hasAnyApiKey(), false);
  });

  it('a config stored before workspace ids existed reads back with an empty one', () => {
    // The storage key was not versioned for this field, so every existing
    // browser hits this path on the next load.
    localStorage.setItem(
      'ifc-lite:api-keys:v1',
      JSON.stringify({ anthropicKey: 'sk-ant-abc', openaiKey: 'sk-oai-xyz' }),
    );
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: '',
      openaiKey: 'sk-oai-xyz',
    });
  });

  it('trims and preserves the anthropic workspace id', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    // Assert on what `updateApiKeys` returns, not only on what reads back:
    // `sanitize` trims on the way out too, so a read-back assertion alone
    // passes with the write-side trim deleted.
    const written = updateApiKeys({ anthropicWorkspaceId: '  wrkspc_01abc  ' });
    assert.equal(written.anthropicWorkspaceId, 'wrkspc_01abc');
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('a workspace id alone does not count as a configured key', () => {
    updateApiKeys({ anthropicWorkspaceId: 'wrkspc_01abc' });
    assert.equal(hasAnthropicKey(), false);
    assert.equal(hasAnyApiKey(), false);
  });

  it('reports whether a workspace id is configured, not only whether keys are', () => {
    // `updateApiKeys` is the only write path, so saving a workspace id fires
    // `byok_key_saved` too. Without this property the event cannot answer the
    // one question the field raises: how many BYOK users actually need it.
    const realCapture = posthog.capture;
    const captured: Array<[string, Record<string, unknown> | undefined]> = [];
    posthog.capture = ((event: string, props?: Record<string, unknown>) => {
      captured.push([event, props]);
    }) as typeof posthog.capture;
    try {
      updateApiKeys({ anthropicKey: 'sk-ant-abc' });
      updateApiKeys({ anthropicWorkspaceId: 'wrkspc_01abc' });
    } finally {
      posthog.capture = realCapture;
    }
    assert.deepEqual(captured.map(([event]) => event), ['byok_key_saved', 'byok_key_saved']);
    assert.deepEqual(captured[0][1], {
      saved_fields: 'anthropicKey',
      has_anthropic: true,
      has_anthropic_workspace: false,
      has_openai: false,
    });
    // `saved_fields` is what separates a workspace-id edit from a key save;
    // without it both look like the same event to any funnel counting them.
    assert.deepEqual(captured[1][1], {
      saved_fields: 'anthropicWorkspaceId',
      has_anthropic: true,
      has_anthropic_workspace: true,
      has_openai: false,
    });
  });

  it('replacing the Anthropic key drops the workspace id the old key was bound to', () => {
    // The dangerous path, and the one this modal's own walkthrough now
    // recommends: swap a multi-workspace key for a single-workspace one.
    // Keeping the id would send every request to a workspace the new key was
    // never granted.
    updateApiKeys({ anthropicKey: 'sk-ant-old', anthropicWorkspaceId: 'wrkspc_01abc' });
    saveCredential('anthropic', { apiKey: 'sk-ant-new' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-new',
      anthropicWorkspaceId: '',
      openaiKey: '',
    });
  });

  it('the FIRST Anthropic key keeps a workspace id entered before it', () => {
    // Both fields are visible from the start, so a new user can fill the
    // workspace box first. There is no old key here, so nothing about the id is
    // stale — "replaces" needs something to replace.
    updateApiKeys({ anthropicWorkspaceId: 'wrkspc_01abc' });
    saveCredential('anthropic', { apiKey: 'sk-ant-first' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-first',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('re-saving the SAME Anthropic key keeps the workspace id', () => {
    // What someone does when a request fails and they want to be sure the key
    // is set. No binding changed, so dropping a correct id here would create
    // the very failure they were checking for.
    updateApiKeys({ anthropicKey: 'sk-ant-abc', anthropicWorkspaceId: 'wrkspc_01abc' });
    saveCredential('anthropic', { apiKey: 'sk-ant-abc' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('replacing the OpenAI key leaves the Anthropic credential alone', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-abc', anthropicWorkspaceId: 'wrkspc_01abc' });
    saveCredential('openai', { apiKey: 'sk-oai-new' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: 'sk-oai-new',
    });
  });

  it('saveCredential trims the key it stores', () => {
    saveCredential('anthropic', { apiKey: '  sk-ant-abc  ' });
    assert.equal(getApiKeys().anthropicKey, 'sk-ant-abc');
  });

  it('saveCredential commits a key and a workspace id in one write', () => {
    saveCredential('anthropic', { apiKey: 'sk-ant-abc', workspaceId: 'wrkspc_01abc' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('saveCredential is one write, so one analytics event per click', () => {
    // Two writes fired byok_key_saved twice and the first reported
    // has_anthropic_workspace:false for a user in the act of saving one —
    // miscounting the exact population that property exists to measure.
    const realCapture = posthog.capture;
    const captured: Array<Record<string, unknown> | undefined> = [];
    posthog.capture = ((_event: string, props?: Record<string, unknown>) => {
      captured.push(props);
    }) as typeof posthog.capture;
    try {
      saveCredential('anthropic', { apiKey: 'sk-ant-abc', workspaceId: 'wrkspc_01abc' });
    } finally {
      posthog.capture = realCapture;
    }
    assert.equal(captured.length, 1, 'one click must produce one event');
    assert.deepEqual(captured[0], {
      saved_fields: 'anthropicKey,anthropicWorkspaceId',
      has_anthropic: true,
      has_anthropic_workspace: true,
      has_openai: false,
    });
  });

  it('saveCredential with an empty key keeps the stored one', () => {
    // The key box is a replace field that starts blank; an empty one is not a
    // request to clear anything.
    updateApiKeys({ anthropicKey: 'sk-ant-abc' });
    saveCredential('anthropic', { apiKey: '', workspaceId: 'wrkspc_01abc' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('saveCredential leaves the clear-on-replace rule alone for an untouched box', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-old', anthropicWorkspaceId: 'wrkspc_01abc' });
    saveCredential('anthropic', { apiKey: 'sk-ant-new' });
    assert.equal(getApiKeys().anthropicWorkspaceId, '');
  });

  it('saveCredential lets a typed workspace id beat the clear-on-replace rule', () => {
    updateApiKeys({ anthropicKey: 'sk-ant-old', anthropicWorkspaceId: 'wrkspc_old' });
    saveCredential('anthropic', { apiKey: 'sk-ant-new', workspaceId: 'wrkspc_new' });
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-new',
      anthropicWorkspaceId: 'wrkspc_new',
      openaiKey: '',
    });
  });

  it('clearProvider drops the whole Anthropic credential, not just the key', () => {
    updateApiKeys({
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: 'sk-oai-xyz',
    });
    clearProvider('anthropic');
    assert.deepEqual(getApiKeys(), {
      anthropicKey: '',
      anthropicWorkspaceId: '',
      openaiKey: 'sk-oai-xyz',
    });
  });

  it('clearProvider("openai") leaves the Anthropic credential intact', () => {
    updateApiKeys({
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: 'sk-oai-xyz',
    });
    clearProvider('openai');
    assert.deepEqual(getApiKeys(), {
      anthropicKey: 'sk-ant-abc',
      anthropicWorkspaceId: 'wrkspc_01abc',
      openaiKey: '',
    });
  });

  it('clearApiKeys resets both keys and the workspace id', () => {
    updateApiKeys({ anthropicKey: 'a', anthropicWorkspaceId: 'wrkspc_01abc', openaiKey: 'b' });
    clearApiKeys();
    assert.deepEqual(getApiKeys(), { anthropicKey: '', anthropicWorkspaceId: '', openaiKey: '' });
  });
});
