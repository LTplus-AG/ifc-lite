/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One assistant message's A2UI state: its own `MessageProcessor` (surface ids
 * such as "main" repeat every turn, so processors are never shared between
 * messages), the ordered text / surface / error segments to render, and the
 * record that persists with the message so a reload replays it without the
 * agent parser.
 *
 * A live session is fed the growing reply as it streams, so surfaces appear
 * while the model is still writing. `RendererState.of(processor)` makes the
 * stream validate each message against what the processor already holds and
 * apply it there, once. Prose comes from `splitA2uiReply`; the parser sees the
 * blocks only, one after another, and what it emits is credited to the block
 * being fed.
 */

import type { ReactCatalogComponent } from '@a2ui/react';
import type { MessageProcessor } from '@a2ui/web_core/v1_0';
import { createIfcAgent, type AgentToRendererMessage, type ResponseStream, type StreamPart } from '@ifc-lite/a2ui/agent';
import type { PersistedA2ui, PersistedA2uiSegment } from '@/lib/llm/types';
import { splitA2uiReply, targetBlockSurface } from '@/lib/llm/a2ui-blocks';
import type { A2uiViewerHost } from './host.js';
import { createRendererProcessor } from './catalog.js';
import { routeAction, type FollowUpHandler } from './actions.js';

export type ChatSegment =
  | { kind: 'text'; text: string }
  | { kind: 'surfaces'; surfaceIds: string[]; messages: AgentToRendererMessage[] }
  | { kind: 'error'; message: string };

let agent: ReturnType<typeof createIfcAgent> | undefined;
function sharedAgent() {
  agent ??= createIfcAgent();
  return agent;
}

function createdSurfaceIds(messages: readonly AgentToRendererMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    const created = (m as { createSurface?: { surfaceId?: unknown } }).createSurface;
    if (created && typeof created.surfaceId === 'string') ids.push(created.surfaceId);
  }
  return ids;
}

interface BlockResult {
  messages: AgentToRendererMessage[];
  errors: string[];
}

export class A2uiMessageSession {
  readonly processor: MessageProcessor<ReactCatalogComponent>;
  segments: readonly ChatSegment[] = [];
  /** The reply text fed so far. */
  content = '';
  closed = false;
  /** Set by the view that shows this session; events become follow-up turns through it. */
  onFollowUp: FollowUpHandler | undefined;
  private stream: ResponseStream<StreamPart> | undefined;
  /** What the parser has been fed: the blocks, separated by newlines. */
  private streamText = '';
  private blocks: BlockResult[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly autoApplied = new Set<string>();

  /** `live`: a reply or push arriving now. A replayed chat record is not live, so it never recolours the model on its own. */
  constructor(host: A2uiViewerHost, readonly live = true) {
    this.processor = createRendererProcessor(host, (action) => routeAction(action, this.onFollowUp));
  }

  /** Rebuild a persisted message: apply its recorded messages in order, no parsing. */
  static replay(host: A2uiViewerHost, record: PersistedA2ui, content: string, live = false): A2uiMessageSession {
    const session = new A2uiMessageSession(host, live);
    const segments: ChatSegment[] = [];
    for (const seg of record.segments) {
      if ('text' in seg) segments.push({ kind: 'text', text: seg.text });
      else if ('error' in seg) segments.push({ kind: 'error', message: seg.error });
      else {
        const messages = seg.messages as AgentToRendererMessage[];
        try {
          session.processor.processMessages(messages);
          segments.push({ kind: 'surfaces', surfaceIds: createdSurfaceIds(messages), messages });
        } catch (error) {
          segments.push({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    session.segments = segments;
    session.content = content;
    session.closed = true;
    return session;
  }

  /** True once per key for a live session: an `onShow` effect runs when a surface first appears, not on every remount. */
  claimAutoApply = (key: string): boolean => {
    if (!this.live || this.autoApplied.has(key)) return false;
    this.autoApplied.add(key);
    return true;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /**
   * Feed the reply as it stands. Returns false when `content` does not extend
   * what was fed (the reply was replaced), in which case the caller starts a
   * new session.
   */
  feed(content: string): boolean {
    if (this.closed) return content === this.content;
    if (!content.startsWith(this.content)) return false;
    if (content === this.content) return true;
    this.content = content;
    const parts = splitA2uiReply(content);
    const blocks = parts.flatMap((p) => (p.kind === 'block' ? [p] : []));
    const raws = blocks.map((b, index) => targetBlockSurface(b.raw, index, b.closed));
    // Blocks only grow at the end, so the parser's input only ever extends.
    let offset = 0;
    raws.forEach((raw, index) => {
      const start = offset + (index > 0 ? 1 : 0);
      const text = (index > 0 ? '\n' : '') + raw;
      let fedHere = Math.max(0, this.streamText.length - offset);
      // The separator flushes whatever the parser held back of the previous block: credit it there.
      if (index > 0 && fedHere === 0) {
        this.feedBlock(index - 1, '\n');
        fedHere = 1;
      }
      if (fedHere < text.length) this.feedBlock(index, text.slice(fedHere));
      offset = start + raw.length;
    });
    this.render(parts);
    return true;
  }

  /** The reply is complete: flush held-back output and report an unclosed block. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.stream) this.credit(this.blocks.length - 1, this.read(() => this.stream!.close()));
    this.render(splitA2uiReply(this.content));
  }

  /** What persists with the message. */
  toRecord(): PersistedA2ui {
    const segments: PersistedA2uiSegment[] = this.segments.map((s) =>
      s.kind === 'text' ? { text: s.text } : s.kind === 'error' ? { error: s.message } : { messages: s.messages });
    return { v: 1, segments };
  }

  hasSurfaces(): boolean {
    return this.segments.some((s) => s.kind !== 'text');
  }

  dispose(): void {
    this.listeners.clear();
    this.processor.dispose();
  }

  private feedBlock(index: number, chunk: string): void {
    this.stream ??= sharedAgent().openStream({ renderer: this.processor });
    this.streamText += chunk;
    while (this.blocks.length <= index) this.blocks.push({ messages: [], errors: [] });
    this.credit(index, this.read(() => this.stream!.feed(chunk)));
  }

  private credit(index: number, parts: StreamPart[]): void {
    if (index < 0) return;
    const block = this.blocks[index];
    for (const part of parts) {
      if (part.type === 'a2ui') block.messages.push(...part.a2ui);
      else if (part.type === 'error') block.errors.push(part.error.message);
    }
  }

  private read(step: () => StreamPart[]): StreamPart[] {
    try {
      return step();
    } catch (error) {
      // A stream opened with afterRejectedBlock: 'continue' only throws once it
      // has ended; keep what it emitted and show why.
      const partial = (error as { partialResults?: StreamPart[] }).partialResults ?? [];
      const message = error instanceof Error ? error.message : String(error);
      return [...partial, { type: 'error', error: { message } } as StreamPart];
    }
  }

  private render(parts: ReturnType<typeof splitA2uiReply>): void {
    const next: ChatSegment[] = [];
    let blockIndex = 0;
    for (const part of parts) {
      if (part.kind === 'text') {
        next.push({ kind: 'text', text: part.text });
        continue;
      }
      const block = this.blocks[blockIndex++];
      if (!block) continue;
      if (block.messages.length) next.push({ kind: 'surfaces', surfaceIds: createdSurfaceIds(block.messages), messages: [...block.messages] });
      for (const message of block.errors) next.push({ kind: 'error', message });
    }
    this.segments = next;
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
