/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP playground is the second consumer of the BYOK Anthropic credential,
 * and it had no coverage: dropping the workspace id in `runConversation`, or
 * passing the wrong one to the error mapper, left the whole suite green while
 * reintroducing on this surface the exact bug the change exists to fix.
 *
 * Both assertions read what actually left the process — the outgoing headers,
 * and the message the panel renders — rather than the arguments handed inward.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, type as typeInto } from '@/test/render.js';
import { captureFetch, jsonResponse } from '@/test/fetch-stub.js';
import { clearApiKeys, updateApiKeys } from '@/services/api-keys';
import { parsePlaygroundModel, type LoadedPlaygroundModel } from './playground-dispatcher.js';
import { PlaygroundChat } from './PlaygroundChat.js';

const WORKSPACE = 'wrkspc_01playground';

/** The composer refuses to send without a model, so give it a one-wall one. */
async function oneWallModel(): Promise<LoadedPlaygroundModel> {
  const step = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', "#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsT3',$,'Wall A',$,$,$,$,$,.STANDARD.);",
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(step);
  return parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'probe.ifc');
}

/** Drive the composer the way a user does: type, then submit the form. */
async function send(container: HTMLElement, prompt: string): Promise<void> {
  const ta = container.ownerDocument.querySelector('textarea');
  assert.ok(ta, 'composer textarea must render');
  typeInto(ta, prompt);
  const { act } = await import('react');
  await act(async () => {
    ta.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('MCP playground BYOK credential', () => {
  beforeEach(() => { clearApiKeys(); });
  afterEach(() => { cleanup(); clearApiKeys(); });

  it('sends anthropic-workspace-id with the playground request', async () => {
    updateApiKeys({ anthropicKey: 'sk-ant-api03-playground', anthropicWorkspaceId: WORKSPACE });
    const stub = captureFetch(() => jsonResponse({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    try {
      const container = render(<PlaygroundChat model={await oneWallModel()} />);
      await send(container, 'hello');
      const anthropic = stub.sent.filter((h) => h.has('x-api-key'));
      assert.ok(anthropic.length > 0, 'expected a request to Anthropic');
      assert.equal(anthropic[0].get('anthropic-workspace-id'), WORKSPACE);
    } finally {
      stub.restore();
    }
  });

  it('does not tell a user who has a workspace id to go add one', async () => {
    // The mapper takes the id the request carried. Handing it '' here produced
    // a dead end: "Add the workspace id" shown to someone who already had.
    updateApiKeys({ anthropicKey: 'sk-ant-api03-playground', anthropicWorkspaceId: WORKSPACE });
    const stub = captureFetch(() => jsonResponse({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'anthropic-workspace-id header must be a valid workspace ID.' },
    }, 400));
    try {
      const container = render(<PlaygroundChat model={await oneWallModel()} />);
      await send(container, 'hello');
      const shown = container.textContent ?? '';
      assert.match(shown, /rejected the Workspace ID/);
      assert.doesNotMatch(shown, /Add the workspace id/);
    } finally {
      stub.restore();
    }
  });
});
