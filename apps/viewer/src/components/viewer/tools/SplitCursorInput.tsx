/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Precise cut distance for the `element.split` command, planted at the
 * cursor as the scene kernel's `CursorInput` (#5503; supersedes the floating
 * `SplitNumericInput` panel with its metres/percent toggle, Cut button and
 * 25/50/75 snap row — one input now does all of that). Mounted through the
 * command's `hud.Scene` while a single-click element (wall / beam / column /
 * member) is hovered; slabs use a two-click cut line that maps to no scalar,
 * so nothing is shown for them.
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
import { useTranslation } from '@/i18n';
import { commitCommand, notifyCommandRefusal, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { SplitGesture } from '@/lib/commands/modeling/commands/element-split';
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

export function SplitCursorInput({ gesture }: { gesture: SplitGesture }) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  // A typed value must not carry over to the next element.
  const targetId = gesture.target?.expressId;
  useEffect(() => {
    setValue('');
  }, [targetId]);

  const hover = gesture.hover;
  if (!gesture.target || gesture.footprint || !hover || hover.length <= 0) return null;

  const commit = (raw: string) => {
    const distance = parseCutDistance(raw, hover.distance, hover.length);
    if (distance === null) {
      notifyCommandRefusal(`Couldn't read "${raw}" as a distance`);
      return;
    }
    if (!Number.isFinite(distance) || distance <= 0 || distance >= hover.length) {
      notifyCommandRefusal(`Distance must be between 0 and ${hover.length.toFixed(2)} m`);
      return;
    }
    // The same commit as a click, at the typed distance: one transaction,
    // one undo step, the same notices (`notifyWallSplit`, #3074).
    updateCommandGesture((g) => ({ ...(g as SplitGesture), typed: distance }));
    commitCommand();
  };

  // Hand focus back to the canvas so keyboard shortcuts (K, R, V, …) keep
  // working — a still-focused input swallows them as text entry.
  const cancel = () => {
    document.querySelector<HTMLElement>('[data-viewport="main"]')?.focus();
  };

  return (
    <CursorInput
      worldPoint={{ x: hover.render[0], y: hover.render[1], z: hover.render[2] }}
      value={value}
      onChange={setValue}
      onCommit={commit}
      onCancel={cancel}
      commitOnBlur={false}
      placeholder={hover.distance.toFixed(2)}
      unit={t('splitTool.unitMetres')}
      ariaLabel={t('splitTool.cutDistanceAria')}
      offset={{ dx: 14, dy: 14 }}
    />
  );
}
