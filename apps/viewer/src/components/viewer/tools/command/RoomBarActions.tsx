/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the Room tool's bars share (charter #6232 M4): running an action as a
 * commit of the command (one transaction, one undo step), changing the
 * gesture from a bar control, and the bar's action button.
 */

import type { ReactNode } from 'react';
import { useViewerStore } from '@/store';
import { resolve as translate } from '@/i18n/registry';
import { commitCommand, notifyCommandRefusal, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import type { LayoutOp } from '@/lib/rooms/room-layout';
import { rememberRoomGesture, type RoomAction, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';

/** Run one of the bar's actions (a layout `op` for `edit`) as a commit of the running command. */
export async function runRoomAction(action: Exclude<RoomAction, 'place'>, op: LayoutOp | null = null): Promise<void> {
  try {
    await ensureSpaceWasm();
  } catch (error) {
    console.error('[room.place] space wasm failed to load', error);
    notifyCommandRefusal(translate('roomTool.wasmFailed'));
    return;
  }
  const set = (next: RoomAction, nextOp: LayoutOp | null) => updateCommandGesture((g) => {
    const room = g as RoomPlaceGesture;
    return { ...room, action: next, edit: { ...room.edit, op: nextOp } };
  });
  set(action, op);
  commitCommand();
  // A refused action leaves the gesture as it was; the next click places again.
  set('place', null);
}

/** Change the running gesture from the bar, and remember it for the session (Escape keeps it). */
export function setRoomGesture(ctx: object, update: (g: RoomPlaceGesture) => RoomPlaceGesture): void {
  updateCommandGesture((g) => {
    const next = update(g as RoomPlaceGesture);
    rememberRoomGesture(ctx, next);
    useViewerStore.getState().setAuthoringDefaults({ roomCreation: {
      minArea: next.minArea, namePattern: next.namePattern, PredefinedType: next.PredefinedType, ObjectType: next.ObjectType,
    } });
    return next;
  });
}

export function BarAction({ onClick, disabled, title, icon, children }: {
  onClick: () => void; disabled?: boolean; title: string; icon: ReactNode; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  );
}
