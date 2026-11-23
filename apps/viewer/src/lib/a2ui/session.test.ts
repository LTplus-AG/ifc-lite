/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One assistant message's A2UI session: fed the reply as it streams (chunks
 * split anywhere, including mid-tag and mid-block), rendered into its own
 * processor, and persisted with the chat message so a reload replays the same
 * surfaces without the parser.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { loadStoredMessages } from '@/store/slices/chatPersistence';
import { extractCodeBlocks } from '@/lib/llm/code-extractor';
import { seedA2uiModels } from '@/test/a2ui-fixture';
import { A2UI_DEMO_REPLY } from './demo-reply';
import { A2uiMessageSession, type ChatSegment } from './session';
import { resetChatSessions, sessionFor, syncSession, STREAMING_MESSAGE_ID } from './chat-sessions';

const kinds = (segments: readonly ChatSegment[]) => segments.map((s) => s.kind);

/** The surface as a renderer holds it: component ids, types and properties. */
function surfaceState(session: A2uiMessageSession, id = 'main'): Record<string, unknown> {
  const surface = session.processor.getSurface(id);
  return Object.fromEntries([...(surface?.componentsModel.values ?? [])].map((c) => [c.id, { type: c.type, props: c.properties }]));
}

function feedInChunks(session: A2uiMessageSession, reply: string, size: number): void {
  for (let end = size; end < reply.length; end += size) assert.equal(session.feed(reply.slice(0, end)), true);
  session.feed(reply);
  session.close();
}

describe('A2uiMessageSession', () => {
  beforeEach(() => resetChatSessions());

  it('builds the same surfaces whether the reply arrives whole or split mid-block', async () => {
    const { host } = await seedA2uiModels();
    const whole = new A2uiMessageSession(host);
    feedInChunks(whole, A2UI_DEMO_REPLY, A2UI_DEMO_REPLY.length);
    for (const size of [1, 7, 33]) {
      const split = new A2uiMessageSession(host);
      feedInChunks(split, A2UI_DEMO_REPLY, size);
      assert.deepEqual(kinds(split.segments), ['text', 'surfaces', 'text'], `chunk ${size}`);
      assert.deepEqual(surfaceState(split), surfaceState(whole), `chunk ${size}`);
    }
    const surface = whole.processor.getSurface('main');
    assert.ok(surface, 'surface main exists');
    for (const id of ['root', 'stats', 'table', 'chart', 'legend', 'actions']) assert.ok(surface.componentsModel.has(id), id);
    const text = whole.segments.filter((s) => s.kind === 'text').map((s) => (s as { text: string }).text).join('');
    assert.ok(!text.includes('<a2ui>') && !text.includes('EntityTable('), 'no DSL leaks into the prose');
  });

  it('shows the surface while the block is still streaming', async () => {
    const { host } = await seedA2uiModels();
    const session = new A2uiMessageSession(host);
    const cut = A2UI_DEMO_REPLY.indexOf('chart = ');
    session.feed(A2UI_DEMO_REPLY.slice(0, cut));
    assert.equal(session.closed, false);
    assert.ok(session.processor.getSurface('main')?.componentsModel.has('table'), 'table is there before </a2ui>');
  });

  it('turns a rejected block into an error segment and keeps the text after it', async () => {
    const { host } = await seedA2uiModels();
    const session = new A2uiMessageSession(host);
    feedInChunks(session, 'Before\n<a2ui>\nroot = Nope(1)\n</a2ui>\nAfter', 5);
    assert.deepEqual(kinds(session.segments), ['text', 'error', 'text']);
    const truncated = new A2uiMessageSession(host);
    feedInChunks(truncated, 'Before\n<a2ui>\nroot = Text("x")\n', 4);
    assert.equal(truncated.segments.at(-1)?.kind, 'error', 'an unclosed block is reported on close');
  });

  it('places two blocks where they were written; a second block reusing surface main is rejected', async () => {
    const { host } = await seedA2uiModels();
    const reply = 'Walls:\n<a2ui>\nroot = StatGroup([{label: "Walls", query: {types: ["IfcWall"]}}])\n</a2ui>\nSlabs:\n<a2ui>\nsurface("slabs")\nroot = EntityList({types: ["IfcSlab"]})\n</a2ui>\nDone';
    for (const size of [3, reply.length]) {
      const session = new A2uiMessageSession(host);
      feedInChunks(session, reply, size);
      const shape = session.segments.map((s) => (s.kind === 'surfaces' ? `surfaces:${s.surfaceIds.join(',')}` : s.kind));
      assert.deepEqual(shape, ['text', 'surfaces:main', 'text', 'surfaces:slabs', 'text'], `chunk ${size}`);
    }
    const clash = new A2uiMessageSession(host);
    feedInChunks(clash, 'A\n<a2ui>\nroot = Text("one")\n</a2ui>\nB\n<a2ui>\nroot = Text("two")\n</a2ui>\nC', 4);
    assert.deepEqual(kinds(clash.segments), ['text', 'surfaces', 'text', 'error', 'text']);
  });

  it('replays a persisted record without parsing, to the same surfaces', async () => {
    const { host } = await seedA2uiModels();
    const live = new A2uiMessageSession(host);
    feedInChunks(live, A2UI_DEMO_REPLY, 50);
    const record = JSON.parse(JSON.stringify(live.toRecord()));
    const replayed = A2uiMessageSession.replay(host, record, A2UI_DEMO_REPLY);
    assert.deepEqual(kinds(replayed.segments), kinds(live.segments));
    assert.deepEqual(surfaceState(replayed), surfaceState(live));
  });

  it('keeps the streaming session for the finalised message, and starts over when a new turn reuses the id', async () => {
    const { host } = await seedA2uiModels();
    const half = A2UI_DEMO_REPLY.slice(0, 400);
    const streaming = syncSession({ id: STREAMING_MESSAGE_ID, content: half }, host, true);
    syncSession({ id: STREAMING_MESSAGE_ID, content: A2UI_DEMO_REPLY }, host, true);
    const final = syncSession({ id: 'final-1', content: A2UI_DEMO_REPLY }, host, false);
    assert.equal(final, streaming, 'adopted, not rebuilt');
    assert.equal(final.closed, true);
    const next = syncSession({ id: STREAMING_MESSAGE_ID, content: 'A new turn' }, host, true);
    assert.notEqual(next, streaming);
    assert.equal(sessionFor({ id: 'final-1', content: A2UI_DEMO_REPLY }, host), final);
  });
});

describe('chat persistence of A2UI messages', () => {
  it('round-trips the record through localStorage and drops malformed ones', async () => {
    const { host } = await seedA2uiModels();
    const session = new A2uiMessageSession(host);
    feedInChunks(session, A2UI_DEMO_REPLY, 64);
    useViewerStore.getState().clearChatMessages();
    const id = useViewerStore.getState().finalizeAssistantMessage(A2UI_DEMO_REPLY);
    useViewerStore.getState().setChatMessageA2ui(id, session.toRecord());
    const stored = loadStoredMessages(null);
    const back = stored.find((m) => m.id === id);
    assert.deepEqual(back?.a2ui, session.toRecord());
    assert.deepEqual(back?.codeBlocks, undefined, 'the <a2ui> block is not an executable code block');

    const key = 'ifc-lite-chat-messages:anonymous';
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>;
    raw[raw.length - 1].a2ui = { v: 2, segments: 'nope' };
    localStorage.setItem(key, JSON.stringify(raw));
    assert.equal(loadStoredMessages(null).find((m) => m.id === id)?.a2ui, undefined);
  });

  it('never extracts a fenced <a2ui> block as a script', () => {
    const reply = 'Here:\n```\n<a2ui>\nroot = Text("bim.query")\n</a2ui>\n```\n```js\nbim.query().byType("IfcWall").count()\n```';
    const blocks = extractCodeBlocks(reply);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].code.startsWith('bim.query()'));
  });
});

describe('chat prompt section', () => {
  it('teaches the IFC catalog and the viewer rules', async () => {
    const { buildA2uiPromptSection, A2UI_CHAT_RULES } = await import('./prompt');
    const section = buildA2uiPromptSection();
    assert.ok(section.startsWith(A2UI_CHAT_RULES));
    for (const name of ['EntityTable(', 'StatGroup(', 'GroupChart(', 'ColorLegend(', 'ActionBar(']) assert.ok(section.includes(name), name);
    assert.ok(section.includes('Never type counts'));
  });
});
