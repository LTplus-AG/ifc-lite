/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The chat path end to end below the network: the recorded reply is played
 * through the same store fields a model stream writes (`playA2uiDemo`), and
 * the chat messages render as `ChatPanel` renders them. Surfaces appear while
 * streaming, the finalised message keeps them and records them for reload, a
 * reload replays the record, and executable code blocks keep working.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { BimReactContext } from '@/sdk/BimProvider';
import { extractCodeBlocks } from '@/lib/llm/code-extractor';
import { cleanup, render, waitFor } from '@/test/render.js';
import { seedA2uiModels } from '@/test/a2ui-fixture';
import { playA2uiDemo } from '@/lib/a2ui/demo';
import { resetChatSessions } from '@/lib/a2ui/chat-sessions';
import { recordingChartRenderer } from '@/test/a2ui-render';
import { A2uiChartRendererContext } from '@/components/a2ui/runtime';
import { ChatMessageComponent } from './ChatMessage';

/** The message list as ChatPanel renders it: finalised messages, then the reply in flight. */
function Messages() {
  const messages = useViewerStore((s) => s.chatMessages);
  const streaming = useViewerStore((s) => s.chatStreamingContent);
  return (
    <div>
      {messages.map((m) => <ChatMessageComponent key={m.id} message={m} />)}
      {streaming && <ChatMessageComponent message={{ id: 'streaming', role: 'assistant', content: streaming, createdAt: 0, codeBlocks: extractCodeBlocks(streaming) }} isStreaming />}
    </div>
  );
}

/** happy-dom has no canvas: the chart engine is a recorder, supplied the way an embedding panel would. */
function mount(bim: BimContext): HTMLElement {
  const { renderer } = recordingChartRenderer();
  return render(
    <BimReactContext.Provider value={bim}>
      <A2uiChartRendererContext.Provider value={renderer}>
        <Messages />
      </A2uiChartRendererContext.Provider>
    </BimReactContext.Provider>,
  );
}

const rows = (el: HTMLElement) => el.querySelectorAll('[data-a2ui-row]').length;

describe('chat messages with A2UI surfaces', () => {
  beforeEach(() => { resetChatSessions(); useViewerStore.getState().clearChatMessages(); });
  afterEach(() => cleanup());

  it('renders surfaces while the reply streams, keeps them when it is final, and records them', async () => {
    const { bim } = await seedA2uiModels();
    const container = mount(bim);
    let sawStreamingTable = false;
    const unsubscribe = useViewerStore.subscribe((s) => {
      if (s.chatStatus === 'streaming' && s.chatStreamingContent.includes('chart = ') && rows(container) > 0) sawStreamingTable = true;
    });
    await playA2uiDemo();
    unsubscribe();
    assert.ok(sawStreamingTable, 'the table showed before the reply finished');
    await waitFor(() => rows(container) === 4, 'final message shows the table');
    const final = useViewerStore.getState().chatMessages.at(-1)!;
    assert.equal(final.role, 'assistant');
    assert.equal(final.codeBlocks, undefined, 'the block is not a script');
    await waitFor(() => !!useViewerStore.getState().chatMessages.at(-1)?.a2ui, 'record persisted');
    assert.ok(container.textContent?.includes('Here is an overview of the walls'));
    assert.ok(!container.textContent?.includes('EntityTable('), 'no DSL in the chat');
  });

  it('replays a recorded message after a reload, without the reply being parsed again', async () => {
    const { bim } = await seedA2uiModels();
    mount(bim);
    await playA2uiDemo();
    await waitFor(() => !!useViewerStore.getState().chatMessages.at(-1)?.a2ui, 'record persisted');
    const record = useViewerStore.getState().chatMessages.at(-1)!.a2ui!;
    cleanup();
    resetChatSessions();
    // A reloaded message whose text no longer parses still shows its recorded surfaces.
    const id = useViewerStore.getState().chatMessages.at(-1)!.id;
    useViewerStore.setState({ chatMessages: [{ id, role: 'assistant', content: 'stale text', createdAt: 0, a2ui: record }] });
    const reloaded = mount(bim);
    await waitFor(() => rows(reloaded) === 4, 'replayed table');
  });

  it('keeps executable code blocks alongside a surface, numbered across the whole reply', async () => {
    const { bim } = await seedA2uiModels();
    const reply = `First:\n\`\`\`js\nconsole.log(1)\n\`\`\`\n<a2ui>\nroot = Text("Surface")\n</a2ui>\nThen:\n\`\`\`js\nconsole.log(2)\n\`\`\``;
    const id = useViewerStore.getState().finalizeAssistantMessage(reply);
    assert.equal(useViewerStore.getState().chatMessages.find((m) => m.id === id)?.codeBlocks?.length, 2);
    const container = mount(bim);
    await waitFor(() => container.querySelectorAll('pre code').length === 2 && !!container.querySelector('[data-a2ui-surface]'), 'code and surface');
    assert.deepEqual([...container.querySelectorAll('pre code')].map((c) => c.textContent), ['console.log(1)', 'console.log(2)']);
    const order = [...container.querySelectorAll('pre code, [data-a2ui-surface]')].map((n) => n.tagName.toLowerCase());
    assert.deepEqual(order, ['code', 'section', 'code']);
  });
});
