/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frames from a PAIRED tab (#9523): results, updates, and everything that
 * must be ignored. Diagnostic strings built from tab input (errors, log lines)
 * are clipped (`sanitize.ts`); result content is passed through unaltered,
 * already bounded by the result limits in `protocol.ts`.
 */

import { BridgeErrorCode, parseTabMessage, type BridgePermission } from './bridge-protocol.js';
import { clip } from './sanitize.js';
import { looseId, type BridgeSession } from './session.js';

export interface SessionFrameContext {
  /** Coalesced log line of one kind. */
  note(kind: string, line: string): void;
  log(line: string): void;
  effectivePermission(): BridgePermission;
  /** The listed tools may have changed. */
  changed(): void;
}

export function handleSessionFrame(s: BridgeSession, text: string, ctx: SessionFrameContext): void {
  const parsed = parseTabMessage(text);
  if (!parsed.ok) {
    const why = clip(parsed.error, 300);
    // A malformed reply to a pending call fails that call now, not at its timeout.
    const id = looseId(text, s.id);
    if (id !== null) s.failOne(id, 'malformed-result', (name) => `The viewer sent a malformed reply to '${name}': ${why}`);
    s.send({ type: 'error', code: BridgeErrorCode.INVALID_MESSAGE, message: why });
    return;
  }
  const msg = parsed.value;
  if (msg.type === 'hello') {
    s.send({ type: 'error', code: BridgeErrorCode.INVALID_MESSAGE, message: 'Already paired; hello is only valid as the first message.' });
    return;
  }
  if (msg.sessionId !== s.id) {
    ctx.note('frames naming another session', `ignored a ${msg.type} naming another session`);
    return;
  }
  if (msg.type === 'result') {
    if (!s.settle(msg.id, msg.result)) ctx.note('stray results', `ignored a result for call ${clip(msg.id, 64)}: not pending (unknown, answered or expired)`);
    return;
  }
  const before = ctx.effectivePermission();
  const toolsBefore = JSON.stringify(s.tools);
  if (msg.permission !== undefined) s.tabPermission = msg.permission;
  if (msg.tools !== undefined) s.tools = msg.tools;
  const after = ctx.effectivePermission();
  const toolsChanged = msg.tools !== undefined && JSON.stringify(msg.tools) !== toolsBefore;
  if (before !== after) ctx.log(`viewer permission is now ${after}`);
  if (before !== after || toolsChanged) ctx.changed();
}
