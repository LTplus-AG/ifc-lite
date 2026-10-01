/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: one viewport press belongs to the command/context that received it. */
import { commandPointerCancel, getCommandRuntime, type CommandRuntimeState } from '@/lib/commands/modeling/runtime';
import { releasePointer } from '@/lib/pointer-capture';
import { useViewerStore } from '@/store';
import { cancelCommandPointer, routeCommandPointer } from './commandPointer.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

interface Press {
  pointerId: number;
  runtime: CommandRuntimeState;
  onPress: boolean;
}

export function createCommandPressController(ctx: MouseHandlerContext) {
  let press: Press | null = null;
  const sameRuntime = (owner: Press) => {
    const current = getCommandRuntime();
    return current.command === owner.runtime.command && current.ctx === owner.runtime.ctx;
  };
  const feed = (kind: 'move' | 'down' | 'up', event: PointerEvent) => {
    const rect = ctx.canvas.getBoundingClientRect();
    return routeCommandPointer(ctx, kind, event.clientX - rect.left, event.clientY - rect.top, event);
  };
  const cancel = (event?: PointerEvent): boolean => {
    if (!press || (event && event.pointerId !== press.pointerId)) return false;
    const owner = press;
    press = null;
    cancelCommandPointer(ctx);
    if (owner.onPress && sameRuntime(owner)) commandPointerCancel();
    ctx.mouseState.didDrag = true; // A cancelled press cannot become a placement click.
    ctx.mouseState.isDragging = false;
    releasePointer(ctx.canvas, owner.pointerId);
    return true;
  };
  const unsubscribe = useViewerStore.subscribe(() => {
    if (press && (!sameRuntime(press) || useViewerStore.getState().activeTool !== 'command')) cancel();
  });
  return {
    captured: () => press !== null && ctx.canvas.hasPointerCapture(press.pointerId),
    begin(event: PointerEvent): boolean {
      cancel();
      const runtime = getCommandRuntime();
      if (!runtime.command || !runtime.ctx) return false;
      cancelCommandPointer(ctx);
      press = { pointerId: event.pointerId, runtime, onPress: runtime.command.pointerDownOnPress?.(runtime.gesture) === true };
      if (press.onPress) feed('down', event);
      return true;
    },
    move(event: PointerEvent): boolean {
      if (!press || event.pointerId !== press.pointerId) return false;
      if (!sameRuntime(press) || (event.buttons & 1) === 0) { cancel(); return true; }
      feed('move', event);
      return true;
    },
    end(event: PointerEvent): boolean {
      if (!press || event.pointerId !== press.pointerId) return false;
      const owner = press;
      press = null; // Clear before releasePointer emits lostpointercapture.
      const current = sameRuntime(owner);
      cancelCommandPointer(ctx);
      ctx.mouseState.didDrag = owner.onPress || !current;
      if (owner.onPress && current) feed('up', event);
      return true;
    },
    cancel,
    dispose() { unsubscribe(); cancel(); cancelCommandPointer(ctx); },
  };
}
