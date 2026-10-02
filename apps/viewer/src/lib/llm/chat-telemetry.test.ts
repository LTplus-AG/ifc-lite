/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ai_chat_message_sent` reached PostHog with NO properties: it sent `model`
 * and `message_count`, and the privacy scrubber deletes any key with a
 * `model` or `message` word. These run every captured payload through the real
 * `scrubEvent` and require it to come out unchanged.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEvent } from '../analytics-scrub.js';
import { chatErrorClass, llmFamily, startChatTurnTelemetry, type ChatTelemetryDeps } from './chat-telemetry.js';
import { BYOK_MODELS } from './models.js';

function harness() {
  let now = 1_000;
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const deps: ChatTelemetryDeps = {
    now: () => now,
    capture: (event, properties) => events.push({ event, properties }),
  };
  return { deps, events, advance: (ms: number) => { now += ms; } };
}

function survivesScrubber(properties: Record<string, unknown>, event: string): void {
  const scrubbed = scrubEvent({ event, properties: { ...properties } });
  assert.deepEqual(scrubbed?.properties, properties, `${event} must pass the scrubber intact`);
}

describe('chat turn telemetry', () => {
  it('sends a populated ai_chat_message_sent that the scrubber leaves intact', () => {
    const h = harness();
    startChatTurnTelemetry({ route: 'anthropic', modelId: 'claude-opus-5-5', turnCount: 7, attachmentCount: 1, kind: 'chat' }, h.deps);
    assert.equal(h.events.length, 1);
    const [sent] = h.events;
    assert.equal(sent.event, 'ai_chat_message_sent');
    assert.deepEqual(sent.properties, {
      provider_kind: 'byok', provider: 'anthropic', llm_family: 'claude', turn_kind: 'chat', turn_count: 7, attachment_count: 1,
    });
    survivesScrubber(sent.properties, sent.event);
  });

  it('settles once with outcome, latency, time to first chunk and finish reason', () => {
    const h = harness();
    const turn = startChatTurnTelemetry({ route: 'proxy', modelId: 'not-in-the-registry', turnCount: 1, attachmentCount: 0, kind: 'repair' }, h.deps);
    h.advance(250);
    turn.noteFirstChunk();
    h.advance(1_000);
    turn.noteFirstChunk(); // only the first counts
    turn.noteFinishReason('max_tokens');
    turn.finish('success', { scriptEdited: true });
    turn.finish('aborted'); // a late abort after completion is ignored
    const done = h.events.filter((e) => e.event === 'ai_chat_response_completed');
    assert.equal(done.length, 1);
    assert.deepEqual(done[0].properties, {
      provider_kind: 'built_in', provider: 'proxy', llm_family: 'unregistered', turn_kind: 'repair',
      outcome: 'success', latency_ms: 1_250, first_chunk_ms: 250, finish_reason: 'length', script_edited: true,
    });
    survivesScrubber(done[0].properties, 'ai_chat_response_completed');
  });

  it('reports an error by class, never by its text', () => {
    const h = harness();
    const turn = startChatTurnTelemetry({ route: 'openai', modelId: 'gpt-6-sol', turnCount: 2, attachmentCount: 0, kind: 'chat' }, h.deps);
    turn.finish('error', { error: new Error('Limit reached for "Client Tower.ifc" project. Please try again later.') });
    const done = h.events[1];
    assert.equal(done.properties.outcome, 'error');
    assert.equal(done.properties.error_class, 'rate_limit');
    assert.equal(done.properties.llm_family, 'gpt');
    assert.doesNotMatch(JSON.stringify(h.events), /Client Tower|Limit reached/);
  });

  it('classifies the viewer\'s own chat error wordings', () => {
    assert.equal(chatErrorClass(new Error('Authentication error.')), 'auth');
    assert.equal(chatErrorClass(new Error('Daily limit reached. Add your own API key in Settings for unlimited access.')), 'rate_limit');
    assert.equal(chatErrorClass(new Error('Chat request timed out. Please try again.')), 'timeout');
    assert.equal(chatErrorClass(new TypeError('Failed to fetch')), 'network');
    assert.equal(chatErrorClass(new Error('Provider routing unavailable for x. Switch model to continue.')), 'provider');
    assert.equal(chatErrorClass(new Error('HTTP 500')), 'http');
    assert.equal(chatErrorClass(new Error('something else')), 'other');
  });

  it('maps every registered BYOK model to a known family', () => {
    for (const model of BYOK_MODELS) assert.notEqual(llmFamily(model.id), 'other', model.id);
    // A stale stored id resolves through the migration table, not as free text.
    assert.equal(llmFamily('claude-opus-4-8'), 'claude');
  });
});
