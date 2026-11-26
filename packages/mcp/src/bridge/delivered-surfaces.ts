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
 *     `Action: <name>` line, or the surface has a `TextField` (the user can
 *     type the prompt), and
 *   - its name is `ask` or a string that appears in that surface (an A2UI
 *     event action's name).
 *
 * The context is not checked here: the tab resolves it from the surface's
 * data and the selection, and the agent reads it as data, never as the
 * user's words (see `channelParams`).
 */

import { ASK_EVENT } from '@ifc-lite/a2ui';
import { isRecord } from './json-bounds.js';
import { a2uiSurfaceTarget, type BridgeUiEvent } from './ui-events.js';

/** Surfaces remembered; the oldest is forgotten past this. */
export const MAX_DELIVERED_SURFACES = 16;
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

  /** Remember the messages of one `tab_show_ui` call. */
  record(messages: readonly unknown[]): void {
    for (const message of messages) {
      const target = a2uiSurfaceTarget(message);
      if (!target) continue;
      const id = target.surfaceId;
      if (target.kind === 'deleteSurface') {
        this.surfaces.delete(id);
        continue;
      }
      // Unioned across calls: the tab keeps one panel per call, and an older
      // panel with the same id stays clickable (until the id is evicted).
      const surface = this.surfaces.get(id) ?? { strings: new Set<string>(), typed: false };
      // Re-inserted, so a surface the agent keeps updating is the newest.
      this.surfaces.delete(id);
      this.surfaces.set(id, surface);
      collect(message, surface);
    }
    while (this.surfaces.size > MAX_DELIVERED_SURFACES) {
      const oldest = this.surfaces.keys().next().value as string;
      this.surfaces.delete(oldest);
    }
  }

  /** Why `event` is refused, or null when it matches a delivered surface. */
  refusal(event: BridgeUiEvent): string | null {
    const surface = this.surfaces.get(event.surfaceId);
    if (!surface) return 'names a surface the agent did not show in this tab';
    const { strings } = surface;
    if (event.name !== ASK_EVENT && !strings.has(event.name)) return 'names an event that surface does not raise';
    if (event.prompt !== undefined) {
      const prompt = event.prompt.trim();
      if (prompt && !surface.typed && !strings.has(prompt) && prompt !== genericPrompt(event.name)) return 'carries a prompt that surface does not contain';
    }
    return null;
  }

  /** A different tab paired: what the previous one was shown does not carry over. */
  clear(): void {
    this.surfaces.clear();
  }
}
