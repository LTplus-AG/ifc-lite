/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Text-level handling of A2UI Express blocks (`<a2ui>…</a2ui>`) in a chat
 * reply. Eager and dependency-free: the chat decides here whether a reply
 * needs the lazily loaded renderer at all, and keeps blocks out of the
 * executable-code path.
 *
 * The prose around blocks is split here rather than taken from the A2UI
 * parser's text parts: the parser treats a ``` fence next to a tag as a
 * wrapper and drops it, which also drops the closing fence of a real code
 * block that happens to sit right before a surface.
 */

const OPEN_TAG = '<a2ui>';
const CLOSE_TAG = '</a2ui>';

export function hasA2uiBlock(content: string): boolean {
  return content.includes(OPEN_TAG);
}

/** A fenced code block that wraps an A2UI block (models sometimes fence them), not a script that mentions the tag. */
export function isA2uiFence(fence: string): boolean {
  return fence.replace(/^```[^\n]*\n?/, '').trimStart().startsWith(OPEN_TAG);
}

export type A2uiReplyPart =
  | { kind: 'text'; text: string }
  /** `raw` is the block as the parser must see it: tags included, closing tag only once written. */
  | { kind: 'block'; raw: string; closed: boolean };

const FENCE_LINE = /^[ \t]*```/gm;
const WRAPPER_OPEN = /```[A-Za-z0-9_-]*[ \t]*\r?\n[ \t]*$/;
const WRAPPER_CLOSE = /^[ \t]*\r?\n?[ \t]*```[ \t]*(?=\r?\n|$)/;

/**
 * Split a reply, complete or still streaming, into prose and blocks in order.
 * An unclosed block runs to the end. A fence line directly around a block is
 * dropped only when it opens a fence (an odd fence count so far), so the
 * closing fence of a code block before a surface stays with its code.
 */
export function splitA2uiReply(content: string): A2uiReplyPart[] {
  const parts: A2uiReplyPart[] = [];
  let fences = 0;
  let at = 0;
  const pushText = (text: string) => {
    if (!text) return;
    fences += (text.match(FENCE_LINE) ?? []).length;
    const last = parts[parts.length - 1];
    if (last?.kind === 'text') last.text += text;
    else parts.push({ kind: 'text', text });
  };
  while (at < content.length) {
    const open = content.indexOf(OPEN_TAG, at);
    if (open === -1) {
      pushText(content.slice(at));
      break;
    }
    let before = content.slice(at, open);
    const wrapper = before.match(WRAPPER_OPEN);
    const fencesBefore = fences + (before.match(FENCE_LINE) ?? []).length;
    const wrapped = !!wrapper && fencesBefore % 2 === 1;
    if (fencesBefore % 2 === 1 && !wrapped) {
      // Inside a code block (a script that mentions the tag): text, not a surface.
      pushText(content.slice(at, open + OPEN_TAG.length));
      at = open + OPEN_TAG.length;
      continue;
    }
    if (wrapped && wrapper) before = before.slice(0, wrapper.index);
    pushText(before);
    const close = content.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
    if (close === -1) {
      parts.push({ kind: 'block', raw: content.slice(open), closed: false });
      break;
    }
    const end = close + CLOSE_TAG.length;
    parts.push({ kind: 'block', raw: content.slice(open, end), closed: true });
    at = end;
    if (wrapped) {
      const tail = content.slice(at).match(WRAPPER_CLOSE);
      if (tail) at += tail[0].length;
    }
  }
  return parts;
}

/**
 * Every Express block without `surface(...)` creates surface `main`, so a
 * second such block in one reply would be rejected as a duplicate. Blocks after
 * the first get their own surface unless their first line names one. The
 * result only ever extends as `raw` streams in (the decision waits for the
 * first line to complete), which the incremental parser feed relies on.
 */
export function targetBlockSurface(raw: string, index: number, closed: boolean): string {
  if (index === 0 || !raw.startsWith(OPEN_TAG)) return raw;
  const body = raw.slice(OPEN_TAG.length);
  const start = body.search(/\S/);
  if (start === -1) return OPEN_TAG;
  const newline = body.indexOf('\n', start);
  const closeAt = body.indexOf(CLOSE_TAG, start);
  const lineEnd = newline === -1 ? (closed ? closeAt : -1) : closeAt === -1 ? newline : Math.min(newline, closeAt);
  if (lineEnd === -1) return OPEN_TAG;
  if (/^surface\s*\(/.test(body.slice(start, lineEnd))) return raw;
  return `${OPEN_TAG}\nsurface("reply-${index + 1}")${body.startsWith('\n') ? '' : '\n'}${body}`;
}

/** The reply without its blocks: what a renderer-less view shows. */
export function stripA2uiBlocks(content: string): string {
  return splitA2uiReply(content).map((p) => (p.kind === 'text' ? p.text : '\n')).join('');
}
