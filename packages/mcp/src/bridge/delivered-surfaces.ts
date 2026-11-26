/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the agent sent to the paired tab with `tab_show_ui`, so a `ui-event`
 * coming back can be checked against it. Without this a tab could raise an
 * event for a surface the agent never showed and carry any prompt; with
 * `--channel` that prompt reaches the agent framed as the user's words.
 *
 * An event is admitted only when its surface id names a surface the agent
 * delivered to this tab, and its name is `ask` or a string that appears in
 * that surface (an A2UI event action's name). Anything else is dropped.
 *
 * An admitted event's prompt is VERIFIED when it is text the agent itself put
 * in that surface (a follow-up prompt, a label, a data value), the
 * renderer's generic `Action: <name>` line, or typed into a `TextField` of
 * that surface. Any other prompt (one the renderer computed, e.g. with
 * `formatString`) is still delivered, but marked unverified, and the agent
 * reads it as data rather than as the user's words (`channelParams`).
 *
 * The context is not checked here: the tab resolves it from the surface's
 * data and the selection, and the agent reads it as data, never as the
 * user's words (see `channelParams`).
 */

import { ASK_EVENT } from '@ifc-lite/a2ui';
import { isRecord } from './json-bounds.js';
import { a2uiSurfaceId, type BridgeUiEvent } from './ui-events.js';

/** Surface ids remembered; the oldest is forgotten past this. Well above what the tab's dock shows (3). */
export const MAX_DELIVERED_SURFACES = 64;
/** Distinct strings remembered per surface; later ones are not admitted as prompts. */
export const MAX_SURFACE_STRINGS = 4096;

/** The renderer's prompt for an event action without a user message (`eventToFollowUp`). */
function genericPrompt(name: string): string {
  return `Action: ${name}`;
}

/** What one surface holds: the agent's strings, and whether the user can type into it. */
interface Surface {
  strings: Set<string>;
  /** It has a `TextField`, so a prompt bound to it is the user's own text, not in `strings`. */
  typed: boolean;
}

function collect(value: unknown, into: Surface): void {
  if (into.strings.size >= MAX_SURFACE_STRINGS) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) into.strings.add(trimmed);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
  } else if (isRecord(value)) {
    if (value.component === 'TextField') into.typed = true;
    for (const item of Object.values(value)) collect(item, into);
  }
}

export class DeliveredSurfaces {
  /** Surface id -> what the agent sent for it. Insertion order is age. */
  private readonly surfaces = new Map<string, Surface>();

  /**
   * Remember the messages of one `tab_show_ui` call. The tab shows a call as
   * one panel and names its clicks by the panel's first surface id, so every
   * id in the call gets the whole call's strings. Ids are unioned across
   * calls and never forgotten on `deleteSurface`: the tab keeps an older panel
   * on screen, and its buttons stay clickable.
   */
  record(messages: readonly unknown[]): void {
    const ids = new Set(messages.map(a2uiSurfaceId).filter((id): id is string => id !== null));
    if (ids.size === 0) return;
    const call: Surface = { strings: new Set<string>(), typed: false };
    collect(messages, call);
    for (const id of ids) {
      const surface = this.surfaces.get(id) ?? { strings: new Set<string>(), typed: false };
      for (const s of call.strings) if (surface.strings.size < MAX_SURFACE_STRINGS) surface.strings.add(s);
      surface.typed ||= call.typed;
      // Re-inserted, so a surface the agent keeps updating is the newest.
      this.surfaces.delete(id);
      this.surfaces.set(id, surface);
    }
    while (this.surfaces.size > MAX_DELIVERED_SURFACES) {
      const oldest = this.surfaces.keys().next().value as string;
      this.surfaces.delete(oldest);
    }
  }

  /** Whether `event` is admitted and, if so, whether its prompt is verified (see the module header). */
  check(event: BridgeUiEvent): { refused: string } | { promptVerified: boolean } {
    const surface = this.surfaces.get(event.surfaceId);
    if (!surface) return { refused: 'names a surface the agent did not show in this tab' };
    const { strings } = surface;
    if (event.name !== ASK_EVENT && !strings.has(event.name)) return { refused: 'names an event that surface does not raise' };
    const prompt = event.prompt?.trim();
    return { promptVerified: !prompt || surface.typed || strings.has(prompt) || prompt === genericPrompt(event.name) };
  }

  /** A different tab paired: what the previous one was shown does not carry over. */
  clear(): void {
    this.surfaces.clear();
  }
}
