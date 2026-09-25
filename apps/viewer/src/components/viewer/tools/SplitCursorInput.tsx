/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Precise cut distance for the Split tool, planted at the cursor as the
 * scene kernel's `CursorInput` (#5503; supersedes the floating
 * `SplitNumericInput` panel with its metres/percent toggle, Cut button and
 * 25/50/75 snap row — one input now does all of that). Mounted through
 * `TOOL_HUD.split.Scene` while a single-click element (wall / beam /
 * column / member) is hovered; slabs use a two-click cut line that maps to
 * no scalar, so nothing is shown for them.
 *
 *   - The input takes focus as it appears, so "hover, type, Enter" needs
 *     no click. Enter commits; Esc hands focus back to the canvas without
 *     committing. Blur does NOT commit: the canvas click that blurs it is
 *     itself the click-split, and a blur commit would cut twice.
 *   - A bare number is metres. A trailing `%` is a fraction of the element
 *     length, so `50%` is what the old Snap 50% button did. Blank commits
 *     at the live cursor distance — the same edit as a click.
 */

import { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { notifyWallSplit } from '../wallSplitNotice.js';
import { useTranslation } from '@/i18n';
import { CursorInput } from '../../viewport-ui/scene';

/**
 * `raw` → a cut distance in metres, or `null` when it does not parse.
 * `hoverDistance` is what blank input means; `length` scales a `%` value.
 */
export function parseCutDistance(raw: string, hoverDistance: number, length: number): number | null {
  const text = raw.trim();
  if (text === '') return hoverDistance;
  const percent = text.endsWith('%');
  const value = Number.parseFloat(percent ? text.slice(0, -1) : text);
  if (!Number.isFinite(value)) return null;
  return percent ? (value / 100) * length : value;
}

export function SplitCursorInput() {
  const { t } = useTranslation();
  const activeTool = useViewerStore((s) => s.activeTool);
  const splitMode = useViewerStore((s) => s.splitMode);
  const splitHoverPoint = useViewerStore((s) => s.splitHoverPoint);
  const splitHoverDistance = useViewerStore((s) => s.splitHoverDistance);
  const splitHoverLength = useViewerStore((s) => s.splitHoverLength);
  const splitTargetModelId = useViewerStore((s) => s.splitTargetModelId);
  const splitTargetExpressId = useViewerStore((s) => s.splitTargetExpressId);
  const splitWallAtDistance = useViewerStore((s) => s.splitWallAtDistance);
  const splitLinearElementAtDistance = useViewerStore((s) => s.splitLinearElementAtDistance);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const clearSplitHover = useViewerStore((s) => s.clearSplitHover);

  const [value, setValue] = useState('');
  // A typed value must not carry over to the next element hovered.
  useEffect(() => {
    setValue('');
  }, [splitTargetExpressId]);

  const eligible =
    activeTool === 'split' &&
    splitMode === 'aiming' &&
    splitHoverPoint !== null &&
    splitHoverLength !== null &&
    splitHoverLength > 0;
  if (!eligible) return null;

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
      // Same notices as the canvas click path — a split committed by typing
      // a distance is the same edit on the same `splitWallAtDistance` result,
      // including the warning when openings could not be reassigned
      // (`openings.skipped`), which this path dropped until #3074.
      notifyWallSplit(wallTry.openings);
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

  const commit = (raw: string) => {
    const distance = parseCutDistance(raw, splitHoverDistance ?? 0, splitHoverLength);
    if (distance === null) {
      toast.error(`Couldn't read "${raw}" as a distance`);
      return;
    }
    commitAt(distance);
  };

  // Hand focus back to the canvas so keyboard shortcuts (K, R, V, …) keep
  // working — a still-focused input swallows them as text entry.
  const cancel = () => {
    document.querySelector<HTMLElement>('[data-viewport="main"]')?.focus();
  };

  return (
    <CursorInput
      worldPoint={{ x: splitHoverPoint[0], y: splitHoverPoint[1], z: splitHoverPoint[2] }}
      value={value}
      onChange={setValue}
      onCommit={commit}
      onCancel={cancel}
      commitOnBlur={false}
      placeholder={(splitHoverDistance ?? 0).toFixed(2)}
      unit={t('splitTool.unitMetres')}
      ariaLabel={t('splitTool.cutDistanceAria')}
      offset={{ dx: 14, dy: 14 }}
    />
  );
}
