/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The one visibility-aware context-menu pick shared by mouse and touch. */
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { refuseCaptureHeldPick } from '@/lib/viewport-capture';
import { isGeometryHeld } from '@/lib/pick-gating';
import { useViewerStore } from '@/store';
import { queueHeldPointerClick } from './heldPointerQueue.js';

type ContextMenuTarget = Pick<MouseHandlerContext, 'canvas' | 'renderer' | 'getPickOptions' | 'openContextMenu'>;

export async function openContextMenuAt(
  { canvas, renderer, getPickOptions, openContextMenu }: ContextMenuTarget,
  clientX: number,
  clientY: number,
): Promise<void> {
  if (isGeometryHeld(useViewerStore.getState())) {
    const rect = canvas.getBoundingClientRect();
    queueHeldPointerClick({ x: clientX - rect.left, y: clientY - rect.top, shiftKey: false,
      ctrlKey: false, metaKey: false, altKey: false, button: 2, handler: 'context-menu',
      replay: () => { void openContextMenuAt({ canvas, renderer, getPickOptions, openContextMenu }, clientX, clientY); } });
    return;
  }
  if (refuseCaptureHeldPick(renderer)) return; // not for an entity a capture's frame shows (#9137)
  const rect = canvas.getBoundingClientRect();
  const picked = await renderer.pick(clientX - rect.left, clientY - rect.top, getPickOptions());
  openContextMenu(picked?.expressId ?? null, clientX, clientY);
}
