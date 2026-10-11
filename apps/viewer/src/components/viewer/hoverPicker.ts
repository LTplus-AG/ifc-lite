/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PickResult } from '@ifc-lite/renderer';
import { captureViewportPick, invalidateViewportPick } from './viewportPickOwnership.js';

type Position = { x: number; y: number; clientX: number; clientY: number };

/** Latest eligible pointer input owns both the trailing timer and readback (#6881). */
export function createHoverPicker(options: {
  owner: Omit<Parameters<typeof captureViewportPick>[0], 'channel'>;
  lastCheck: { current: number };
  throttleMs: number;
  commit: (result: PickResult, position: Position) => void;
  clear: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const cancel = () => {
    invalidateViewportPick(options.owner.canvas, 'hover');
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (position: Position) => {
    if (disposed) return;
    cancel();
    const request = captureViewportPick({ ...options.owner, channel: 'hover' });
    const run = async () => {
      timer = null;
      if (disposed || !request.current()) return;
      options.lastCheck.current = Date.now();
      try {
        const result = await options.owner.renderer.pick(position.x, position.y, request.pickOptions);
        if (disposed || !request.current()) return;
        if (result) options.commit(result, position);
        else options.clear();
      } catch (error) {
        console.warn('[useMouseControls] Hover picking failed:', error);
        if (!disposed && request.current()) options.clear();
      }
    };
    // A wall-clock adjustment cannot stretch the throttle beyond one interval.
    const interval = Math.max(0, options.throttleMs);
    const remaining = Math.min(interval, Math.max(0, options.lastCheck.current + interval - Date.now()));
    if (remaining === 0) void run();
    else timer = setTimeout(() => { void run(); }, remaining);
  };
  return { schedule, cancel, dispose() { disposed = true; cancel(); } };
}
