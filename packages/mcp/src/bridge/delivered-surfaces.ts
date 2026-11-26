/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the agent sent to the paired tab with `tab_show_ui`, so a `ui-event`
 * coming back can be checked against it. Without this a tab could raise an
 * event for a surface the agent never showed and carry any prompt; with
 * `--channel` that prompt reaches the agent framed as the user's words.
 *
 * An event is admitted only when
 *   - its surface id names a surface the agent delivered to this tab, and
 *   - its prompt, if any, is text the agent itself put in that surface (a
 *     follow-up prompt, a label, a data value), or the renderer's generic
 *     `Action: <name>` line, and
 *   - its name is `ask` or a string that appears in that surface (an A2UI
 *     event action's name).
 *
 * The context is not checked here: the tab resolves it from the surface's
 * data and the selection, and the agent reads it as data, never as the
 * user's words (see `channelParams`).
 */

import { ASK_EVENT } from '@ifc-lite/a2ui';
import { isRecord } from './json-bounds.js';
import type { BridgeUiEvent } from './ui-events.js';

/** Surfaces remembered; the oldest is forgotten past this. */
export const MAX_DELIVERED_SURFACES = 16;

/** The renderer's prompt for an event action without a user message (`eventToFollowUp`). */
function genericPrompt(name: string): string {
  return `Action: ${name}`;
}

function collectStrings(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

/** The surface a v1.0 message is about (`{ createSurface: { surfaceId } }` and its siblings). */
function surfaceIdOf(message: unknown): { id: string; deleted: boolean } | null {
  if (!isRecord(message)) return null;
  for (const [kind, body] of Object.entries(message)) {
    if (isRecord(body) && typeof body.surfaceId === 'string' && body.surfaceId) {
      return { id: body.surfaceId, deleted: kind === 'deleteSurface' };
    }
  }
  return null;
}

export class DeliveredSurfaces {
  /** Surface id -> every trimmed string the agent sent for it. Insertion order is age. */
  private readonly surfaces = new Map<string, Set<string>>();

  /** Remember the messages of one `tab_show_ui` call. */
  record(messages: readonly unknown[]): void {
    for (const message of messages) {
      const target = surfaceIdOf(message);
      if (!target) continue;
      if (target.deleted) {
        this.surfaces.delete(target.id);
        continue;
      }
      const strings = this.surfaces.get(target.id) ?? new Set<string>();
      // Re-inserted, so a surface the agent keeps updating is the newest.
      this.surfaces.delete(target.id);
      this.surfaces.set(target.id, strings);
      collectStrings(message, strings);
    }
    while (this.surfaces.size > MAX_DELIVERED_SURFACES) {
      const oldest = this.surfaces.keys().next().value as string;
      this.surfaces.delete(oldest);
    }
  }

  /** Why `event` is refused, or null when it matches a delivered surface. */
  refusal(event: BridgeUiEvent): string | null {
    const strings = this.surfaces.get(event.surfaceId);
    if (!strings) return 'names a surface the agent did not show in this tab';
    if (event.name !== ASK_EVENT && !strings.has(event.name)) return 'names an event that surface does not raise';
    if (event.prompt !== undefined) {
      const prompt = event.prompt.trim();
      if (prompt && !strings.has(prompt) && prompt !== genericPrompt(event.name)) return 'carries a prompt that surface does not contain';
    }
    return null;
  }

  /** A different tab paired: what the previous one was shown does not carry over. */
  clear(): void {
    this.surfaces.clear();
  }
}
