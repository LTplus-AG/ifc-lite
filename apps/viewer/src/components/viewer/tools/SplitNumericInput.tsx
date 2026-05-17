/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Numeric input panel for the Split tool. Mounted by ToolOverlays
 * alongside SplitOverlay while `activeTool === 'split'`. Surfaces
 * a small floating input near the hover preview that lets the user
 * type a precise distance (metres) or percent (0..100) instead of
 * relying on cursor positioning.
 *
 * Renders only for the single-click element types (wall, beam,
 * column, member) — slabs use a two-click cut line that doesn't
 * map to a single scalar. The panel disappears between hovers so
 * it doesn't compete with the cursor.
 *
 * Behaviour:
 *
 *   - Tab into the panel from anywhere (or Cmd+/ to focus) and
 *     type a number; the live preview updates as you type.
 *   - Enter commits at the typed distance (or, if blank, at the
 *     current cursor distance — same as a click).
 *   - Esc returns focus to the canvas without committing.
 *   - Quick snap buttons: 25% / 50% / 75% jump the distance to
 *     fractions of the element length — common gesture and the
 *     panel stays useful even without numeric input.
 *
 * The panel is positioned next to the cursor via cameraCallbacks
 * .projectToScreen(splitHoverPoint); it tracks the camera the same
 * way SplitOverlay does, via splitHoverPoint updates.
 */

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';

const ACCENT = '#a855f7'; // purple-500
const PANEL_OFFSET_PX = 32;

export function SplitNumericInput() {
  const activeTool = useViewerStore((s) => s.activeTool);
  const splitMode = useViewerStore((s) => s.splitMode);
  const splitHoverPoint = useViewerStore((s) => s.splitHoverPoint);
  const splitHoverDistance = useViewerStore((s) => s.splitHoverDistance);
  const splitHoverLength = useViewerStore((s) => s.splitHoverLength);
  const splitTargetModelId = useViewerStore((s) => s.splitTargetModelId);
  const splitTargetExpressId = useViewerStore((s) => s.splitTargetExpressId);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const splitWallAtDistance = useViewerStore((s) => s.splitWallAtDistance);
  const splitLinearElementAtDistance = useViewerStore((s) => s.splitLinearElementAtDistance);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const clearSplitHover = useViewerStore((s) => s.clearSplitHover);

  const [inputValue, setInputValue] = useState('');
  const [inputMode, setInputMode] = useState<'metres' | 'percent'>('metres');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the input whenever the target wall changes — sticky
  // input across targets would be confusing.
  useEffect(() => {
    setInputValue('');
  }, [splitTargetExpressId]);

  // Only render in the single-click element flow. Slab two-click
  // flow has its own pathway (no scalar input).
  const eligible =
    activeTool === 'split' &&
    splitMode === 'aiming' &&
    splitHoverPoint !== null &&
    splitHoverLength !== null &&
    splitHoverLength > 0;
  if (!eligible || !projectToScreen) return null;

  const cutScreen = projectToScreen({
    x: splitHoverPoint[0],
    y: splitHoverPoint[1],
    z: splitHoverPoint[2],
  });
  if (!cutScreen) return null;

  const commitAt = (distance: number) => {
    if (splitTargetModelId === null || splitTargetExpressId === null) return;
    if (!Number.isFinite(distance) || distance <= 0 || distance >= splitHoverLength) {
      toast.error(`Distance must be between 0 and ${splitHoverLength.toFixed(2)} m`);
      return;
    }
    const wallTry = splitWallAtDistance(splitTargetModelId, splitTargetExpressId, distance);
    if (wallTry.ok) {
      clearSplitHover();
      setSelectedEntityId(wallTry.right.globalId);
      const op = wallTry.openings;
      const opSummary =
        op.toLeft + op.toRight > 0
          ? ` (${op.toLeft + op.toRight} opening${op.toLeft + op.toRight === 1 ? '' : 's'} reassigned)`
          : '';
      toast.success(`Wall split${opSummary} — Ctrl+Z to undo`);
      return;
    }
    const linearTry = splitLinearElementAtDistance(splitTargetModelId, splitTargetExpressId, distance);
    if (linearTry.ok) {
      clearSplitHover();
      setSelectedEntityId(linearTry.right.globalId);
      toast.success('Element split — Ctrl+Z to undo');
      return;
    }
    const reason = linearTry.ok === false ? linearTry.reason : wallTry.reason;
    toast.error(`Couldn't split: ${reason}`);
  };

  const parsedDistance = (): number => {
    const raw = parseFloat(inputValue);
    if (!Number.isFinite(raw)) return splitHoverDistance ?? 0;
    return inputMode === 'metres' ? raw : (raw / 100) * (splitHoverLength ?? 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitAt(parsedDistance());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
      // Move focus back to the viewport canvas so keyboard
      // shortcuts (K, R, V, …) keep working — without this, the
      // input field still has focus from the browser's
      // perspective and global keyboard listeners ignore the
      // event because it's targeted at the input.
      const canvas = document.querySelector<HTMLElement>('[data-viewport="main"]');
      canvas?.focus();
    }
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const snapTo = (fraction: number) => {
    commitAt(fraction * (splitHoverLength ?? 0));
  };

  return (
    <div
      className="absolute z-30 pointer-events-auto"
      style={{
        left: cutScreen.x + PANEL_OFFSET_PX,
        top: cutScreen.y + PANEL_OFFSET_PX,
      }}
    >
      <div
        className="bg-white dark:bg-zinc-900 border-2 shadow-lg rounded-md
          flex flex-col gap-1.5 p-2 text-xs"
        style={{ borderColor: ACCENT, minWidth: 200 }}
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setInputMode('metres')}
            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase
              ${inputMode === 'metres'
                ? 'bg-purple-600 text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}`}
          >
            m
          </button>
          <button
            type="button"
            onClick={() => setInputMode('percent')}
            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase
              ${inputMode === 'percent'
                ? 'bg-purple-600 text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}`}
          >
            %
          </button>
          <span className="flex-1" />
          <span className="text-[10px] font-mono text-zinc-500">
            of {splitHoverLength?.toFixed(2)}m
          </span>
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="number"
            step="any"
            value={inputValue}
            placeholder={
              inputMode === 'metres'
                ? splitHoverDistance?.toFixed(2)
                : (((splitHoverDistance ?? 0) / (splitHoverLength ?? 1)) * 100).toFixed(1)
            }
            onChange={onChange}
            onKeyDown={onKeyDown}
            className="flex-1 px-2 py-1 border border-zinc-300 dark:border-zinc-700
              bg-white dark:bg-zinc-950 text-xs font-mono rounded
              focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
          <button
            type="button"
            onClick={() => commitAt(parsedDistance())}
            className="px-2 py-1 bg-purple-600 text-white text-[10px]
              font-medium rounded hover:bg-purple-700"
          >
            Cut
          </button>
        </div>
        <div className="flex items-center gap-1 text-[10px]">
          <span className="text-zinc-500">Snap</span>
          {[0.25, 0.5, 0.75].map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => snapTo(f)}
              className="px-1.5 py-0.5 rounded
                bg-zinc-100 dark:bg-zinc-800
                hover:bg-purple-100 dark:hover:bg-purple-950
                text-zinc-700 dark:text-zinc-300 font-mono"
            >
              {(f * 100).toFixed(0)}%
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
