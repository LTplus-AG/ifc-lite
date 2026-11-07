/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The last pointer position a running command saw, so pressing or releasing
 * Alt over a still pointer moves the preview and the HUD at once: otherwise
 * the mark would be out of date until the pointer next moves, and the click
 * would land somewhere the HUD wasn't showing (#9201). Whichever view the
 * pointer is in (`commandPointer.ts`, `PlanPointer.ts`) keeps it current.
 * The snap toggle replays it too, with the keys as they last were.
 */

/** The modifiers a replay resolves with: the keys as they are now, not at the last move. */
export interface ReplayKeys { altKey: boolean; shiftKey: boolean }
type Replay = (keys: ReplayKeys) => void;

let replay: Replay | null = null;
let keys: ReplayKeys = { altKey: false, shiftKey: false };

/** After every pointer event a command took, so a key press reads where the pointer is now. */
export function rememberCommandPointer(next: Replay, now: ReplayKeys): void {
  replay = next;
  keys = { altKey: now.altKey, shiftKey: now.shiftKey };
}

/** The pointer left the view, or the command changed: a key press has no position to read any more. */
export function forgetCommandPointer(): void {
  replay = null;
}

export function replayCommandPointer(now: ReplayKeys = keys): void {
  replay?.(now);
}
