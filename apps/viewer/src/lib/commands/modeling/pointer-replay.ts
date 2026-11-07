/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The last pointer position a running command saw, so pressing or releasing
 * Alt over a still pointer moves the preview and the HUD at once: otherwise
 * the mark would be out of date until the pointer next moves, and the click
 * would land somewhere the HUD wasn't showing (#9201). Whichever view the
 * pointer is in (`commandPointer.ts`, `PlanPointer.ts`) keeps it current.
 * The snap toggle replays it too, with Alt as it last was.
 */

type Replay = (altKey: boolean) => void;

let replay: Replay | null = null;
let alt = false;

export function rememberCommandPointer(next: Replay, altKey: boolean): void {
  replay = next;
  alt = altKey;
}

/** The pointer left the view: a key press has no position to read any more. */
export function forgetCommandPointer(): void {
  replay = null;
}

export function replayCommandPointer(altKey: boolean = alt): void {
  replay?.(altKey);
}
