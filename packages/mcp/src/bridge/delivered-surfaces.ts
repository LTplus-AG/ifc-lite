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
 * sent to this tab, and its name is `ask` or the name of an event action
 * (`{ event: { name } }`) in that surface. Anything else is dropped.
 *
 * An admitted event's prompt is VERIFIED only when it is follow-up text the
 * agent wrote in that surface: the value of a `prompt`, `userMessage` or
 * `label` key, or the renderer's generic `Action: <name>` line. Data values
 * (entity names, property values) never verify a prompt: they may come from
 * the model. Any other prompt, typed into a field or computed by the
 * renderer, is still delivered, but marked unverified, and the agent reads it
 * as quoted data rather than as the user's words (`channelParams`).
 *
 * A surface is recorded when it is sent, not when the tab confirms it: a tab
 * may store and show it even if its answer is lost or the call times out,
 * and what is recorded is only text the agent wrote.
 */

import { ASK_EVENT, eventToFollowUp } from '@ifc-lite/a2ui';
import { isRecord } from './json-bounds.js';
import { a2uiSurfaceId, type BridgeUiEvent } from './ui-events.js';

/** Surface ids remembered; the oldest is forgotten past this. Well above what the tab's dock shows (3). */
export const MAX_DELIVERED_SURFACES = 64;
/** Follow-up texts and event names remembered per surface, each. */
export const MAX_SURFACE_ENTRIES = 1024;

/**
 * Keys whose string value is follow-up text the agent wrote. A `label` is
 * the button's own text: the renderer sends it as the prompt of an event
 * without a user message, and the agent chose it, unlike a data value.
 */
const PROMPT_KEYS: ReadonlySet<string> = new Set(['prompt', 'userMessage', 'label']);

/** The renderer's prompt for an event action without a user message. */
function genericPrompt(name: string): string {
  return eventToFollowUp(name, undefined).userText;
}

function emptySurface(): Surface {
  return { prompts: new Set(), events: new Set() };
}

/** What one surface may send back. */
interface Surface {
  prompts: Set<string>;
  events: Set<string>;
}

function add(set: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (trimmed && set.size < MAX_SURFACE_ENTRIES) set.add(trimmed);
}

/** `from` is already trimmed; only the cap applies. */
function merge(into: Set<string>, from: Set<string>): void {
  for (const value of from) if (into.size < MAX_SURFACE_ENTRIES) into.add(value);
}

function collect(value: unknown, into: Surface): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && PROMPT_KEYS.has(key)) add(into.prompts, item);
    if (key === 'event' && isRecord(item) && typeof item.name === 'string') add(into.events, item.name);
    collect(item, into);
  }
}

type SurfaceCheck = { refused: string } | { promptVerified: boolean };

export class DeliveredSurfaces {
  /** Surface id -> what the agent sent for it. Insertion order is age. */
  private readonly surfaces = new Map<string, Surface>();

  /**
   * Remember the messages of one `tab_show_ui` call. The tab shows a call as
   * one panel and names its clicks by the panel's first surface id, so every
   * id in the call gets the whole call. Ids are unioned across calls and
   * never forgotten on `deleteSurface`: the tab keeps an older panel on
   * screen, and its buttons stay clickable.
   */
  record(messages: readonly unknown[]): void {
    const ids = new Set(messages.map(a2uiSurfaceId).filter((id): id is string => id !== null));
    if (ids.size === 0) return;
    const call = emptySurface();
    collect(messages, call);
    for (const id of ids) {
      const surface = this.surfaces.get(id) ?? emptySurface();
      merge(surface.prompts, call.prompts);
      merge(surface.events, call.events);
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
  check(event: BridgeUiEvent): SurfaceCheck {
    const surface = this.surfaces.get(event.surfaceId);
    if (!surface) return { refused: 'names a surface the agent did not show in this tab' };
    if (event.name !== ASK_EVENT && !surface.events.has(event.name)) return { refused: 'names an event that surface does not raise' };
    const prompt = event.prompt?.trim();
    return { promptVerified: !prompt || surface.prompts.has(prompt) || prompt === genericPrompt(event.name) };
  }

  /** A different tab paired: what the previous one was shown does not carry over. */
  clear(): void {
    this.surfaces.clear();
  }
}
