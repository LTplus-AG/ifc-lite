/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command tool's touch press (#9092): what a mouse press, drag, release
 * and click do in a running modeling command, for a finger and an Apple
 * Pencil (#9000), through the mouse's command-pointer path
 * (`routeCommandPointer`).
 *
 *  - A tap is the click: the command's down. A second tap that lands within
 *    the double-tap time of the first's lift and the tap slop of it
 *    (`tapSlop.ts`) is the second click of a double-click (`detail: 2`, `commandDoubleClick`):
 *    it ends a wall chain, or closes a slab or railing polygon.
 *  - A command that follows the press itself (`pointerDownOnPress`, room.place
 *    edit mode): a drag from where a press grabs something (`pressDrags`, a
 *    room corner) is the command's, a press where the finger landed and a
 *    release where it lifted, as a mouse press-drag. A drag from anywhere else
 *    orbits and presses nothing, since touch has no other one-finger orbit: a
 *    finger turning the view must not drop a grabbed corner, remove a room or
 *    start a cut, nor leave a hover that Enter would commit. The press waits
 *    for the drag, so the first finger of a pinch presses nothing; a press that
 *    grabs has no long press, so resting on a corner before dragging still
 *    drags it; the touch's own native menu stays suppressed there (#9228). A tap is a press and a release in place, as a mouse press and
 *    release.
 *  - A press outlives its command when the command or the tool changed before
 *    it lifted (Esc on an untouched command, a keyboard command switch, a tool
 *    switch): it places nothing and selects nothing, as the mouse drops a click
 *    whose press began under another command (`commandPress.ts`). A press that
 *    began in another tool places nothing in the command it lifts in. Either
 *    way its compatibility click is the tap's, and is dropped too.
 *  - Shift (angle step) and Alt (suspend snapping) are read from the touch
 *    event, which carries a hardware keyboard's modifiers (an iPad keyboard),
 *    as a click's are. With no keyboard both are up: a plain click.
 *  - Touch has no hover to move or clear the snap marker a tap leaves, so the
 *    next touch press clears it.
 */

import { commandPointerCancel, getCommandRuntime, type CommandRuntimeState } from '@/lib/commands/modeling/runtime';
import type { PointerModifiers } from '@/lib/commands/modeling/snap-solve';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelCommandPointer, routeCommandPointer, routeCommandPressDrag } from './commandPointer.js';
import { markTouchSelection } from './referenceSelection.js';
import { withinTapSlop } from './tapSlop.js';
import { routeToolTap } from './toolTap.js';
import { viewportHandlerContext } from './touchRouting.js';

/** From a tap's lift to the next tap's press, as Android's double-tap timeout and the selection path's 300 ms. */
const DOUBLE_TAP_MS = 300;

interface Press {
  ctx: MouseHandlerContext;
  runtime: CommandRuntimeState;
  /** The command follows the press (`pointerDownOnPress`). */
  onPress: boolean;
  /** For `onPress`: the finger started to drag; `dragging` when the command took the drag. */
  pressed: boolean;
  dragging: boolean;
  /** The press's finger (`Touch.identifier`), and where it last was (canvas CSS px). */
  finger: number;
  at: { x: number; y: number };
}

type Modifiers = Pick<TouchEvent, 'shiftKey' | 'altKey'>;
const modifiers = (e: Modifiers, detail = 1): PointerModifiers => ({ shiftKey: e.shiftKey === true, altKey: e.altKey === true, detail });

export interface CommandTouchPress {
  /** One finger landed with none down: true when it landed where a press grabs, so a long press must not take its drag. */
  begin(touch: Touch, e: Modifiers): boolean;
  /** The one finger moved past the tap slop: true when the command drags, so the camera stays. */
  move(touch: Touch, e: Modifiers): boolean;
  /** All fingers lifted; `tap` whether the press was a tap. True when the press belongs to the command tool: nothing else acts on it. */
  end(tap: boolean, e: Modifiers & Pick<TouchEvent, 'changedTouches'>): boolean;
  /** A second finger, a touchcancel, or teardown: the press is no one's. */
  cancel(): void;
}

export function createCommandTouchPress(canvas: HTMLCanvasElement, getTool: () => string): CommandTouchPress {
  let press: Press | null = null;
  /** Where and when the last touch press landed, in any tool (canvas CSS px). */
  let landed = { x: 0, y: 0, time: 0 };
  let lastTap: { runtime: CommandRuntimeState; x: number; y: number; time: number; count: number } | null = null;
  /** The handler context whose snap marker a touch left. */
  let marked: MouseHandlerContext | null = null;

  const sameRuntime = (a: CommandRuntimeState, b: CommandRuntimeState) => a.command === b.command && a.ctx === b.ctx;
  const live = (p: Press) => sameRuntime(getCommandRuntime(), p.runtime) && getTool() === 'command';
  const canvasPoint = (touch: Touch) => {
    const rect = canvas.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };
  const clearMarker = () => {
    marked?.setSnapTarget(null);
    marked = null;
  };
  /** As the mouse's cancelled press: a drag the command owns is abandoned. */
  const dropPress = () => {
    const p = press;
    press = null;
    if (!p) return;
    cancelCommandPointer(p.ctx);
    if (p.dragging && live(p)) commandPointerCancel();
  };
  /** A tap's click count, as the browser counts a click's `detail`. */
  const clickCount = (runtime: CommandRuntimeState) => {
    const { x, y, time } = landed;
    const again = lastTap !== null && sameRuntime(lastTap.runtime, runtime) && time - lastTap.time < DOUBLE_TAP_MS
      && withinTapSlop(x, y, lastTap);
    lastTap = { runtime, x, y, time: Date.now(), count: again && lastTap ? lastTap.count + 1 : 1 };
    return lastTap.count;
  };

  return {
    begin(touch, e) {
      dropPress();
      clearMarker();
      landed = { ...canvasPoint(touch), time: Date.now() };
      const ctx = viewportHandlerContext(canvas);
      const runtime = getCommandRuntime();
      if (!ctx || getTool() !== 'command' || !runtime.command || !runtime.ctx) return false;
      press = {
        ctx, runtime, onPress: runtime.command.pointerDownOnPress?.(runtime.gesture) === true,
        pressed: false, dragging: false, finger: touch.identifier, at: { x: landed.x, y: landed.y },
      };
      if (!press.onPress) return false;
      const grabs = routeCommandPressDrag(ctx, landed.x, landed.y, modifiers(e), false);
      marked = ctx; // the marker shows what the press would grab
      if (!grabs) clearMarker();
      return grabs;
    },
    move(touch, e) {
      const p = press;
      if (!p?.onPress) return false;
      if (!live(p)) return p.dragging; // the command ended under its drag: the rest of the drag moves nothing
      if (!p.pressed) {
        p.pressed = true;
        lastTap = null;
        p.dragging = routeCommandPressDrag(p.ctx, landed.x, landed.y, modifiers(e), true);
        marked = p.ctx;
        if (!p.dragging) clearMarker(); // the finger orbits
      }
      if (!p.dragging) return false;
      p.at = canvasPoint(touch);
      routeCommandPointer(p.ctx, 'move', p.at.x, p.at.y, modifiers(e));
      return true;
    },
    end(tap, e) {
      const p = press;
      press = null;
      const { x, y } = landed;
      if (!p || !live(p)) {
        if (p) { cancelCommandPointer(p.ctx); clearMarker(); }
        // A press that began in another tool or with no command running, or that outlived its
        // command or tool, places nothing and selects nothing: nor does its compatibility click.
        // A press begun in the command is marked however long it was: the tool it lifts in may
        // count no tap past its own window (Select's 300 ms), yet a compatibility click still follows.
        const owned = p !== null || getTool() === 'command';
        if (owned && (tap || p !== null)) markTouchSelection(canvas, x, y);
        return owned;
      }
      const { ctx } = p;
      if (p.dragging) {
        // The release lands where the finger lifted, which a last move need not have reported
        const lifted = Array.from(e.changedTouches ?? []).find((t) => t.identifier === p.finger);
        const at = lifted ? canvasPoint(lifted) : p.at;
        routeCommandPointer(ctx, 'up', at.x, at.y, modifiers(e));
      }
      else if (!tap) {
        cancelCommandPointer(ctx);
        lastTap = null;
        return true;
      } else if (p.onPress) {
        routeToolTap(ctx, 'command', x, y, () => { // a press and a release in place
          routeCommandPointer(ctx, 'down', x, y, modifiers(e));
          routeCommandPointer(ctx, 'up', x, y, modifiers(e));
        });
      } else {
        const detail = clickCount(p.runtime);
        routeToolTap(ctx, 'command', x, y, () => routeCommandPointer(ctx, 'down', x, y, modifiers(e, detail)));
      }
      marked = ctx;
      return true;
    },
    cancel() {
      dropPress();
      lastTap = null;
      clearMarker();
    },
  };
}
