/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeasureMode } from '@/store/types.js';

export type PointerGesture = 'fly' | 'orbit' | 'pan' | 'tool';

export interface PointerGestureInput {
  tool: string;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  measureMode: MeasureMode;
  /** The existing right-button fly mode (#4868) owns the press when enabled. */
  flyEnabled: boolean;
}

/** One modifier/button decision for orbit, pan, and tool drags (#5887). */
export function resolvePointerGesture(input: PointerGestureInput): PointerGesture {
  const { tool, button, shiftKey, ctrlKey, metaKey, altKey, measureMode, flyEnabled } = input;
  if (button === 2) return flyEnabled ? 'fly' : 'pan';
  if (button === 1) return 'pan';
  if (button !== 0) return 'orbit';
  if (shiftKey || tool === 'pan') return 'pan';
  if (tool === 'select' && (ctrlKey || metaKey)) return 'tool';
  if (tool === 'measure' && measureMode === 'drag' && !altKey) return 'tool';
  return 'orbit';
}
