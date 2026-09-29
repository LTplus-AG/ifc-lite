/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Room tool's layout controls (charter #6232 M4, the Space Sketch
 * features it took over), on `room.place`'s bar:
 *
 *   - Edit mode's two tools (Move · Cut, Merge · Remove) and Clean up (the
 *     plate's `prune`, one undo step);
 *   - More ▾: Footprint (one room over the storey's outline), Auto on every
 *     storey, the manual corner weld (with the room count it gives) and the
 *     leak diagnostics toggle.
 */

import { Building2, ChevronDown, Eraser, RotateCcw, SquareDashed } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { DEFAULT_WELD } from '@/lib/rooms/room-layout';
import { initRoomEdit, type RoomEditTool, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { HudPopover, HudPopoverContent, HudPopoverTrigger, HudSegmented, HudToggle } from '../../../viewport-ui/hud';
import { BarAction, runRoomAction, setRoomGesture } from './RoomBarActions';

const TOOL_KEYS: Record<RoomEditTool, TranslationKey> = {
  shape: 'roomLayout.tool.shape',
  remove: 'roomLayout.tool.remove',
};
const TOOL_TITLES: Record<RoomEditTool, TranslationKey> = {
  shape: 'roomLayout.tool.shapeTitle',
  remove: 'roomLayout.tool.removeTitle',
};

/** Edit mode: which edit a click makes, and Clean up. */
export function RoomEditTools({ gesture, ctx }: CommandHudProps<RoomPlaceGesture>) {
  const { t } = useTranslation();
  return (
    <>
      <HudSegmented
        aria-label={t('roomLayout.tool.label')}
        options={(['shape', 'remove'] as const).map((value) => ({ value, label: t(TOOL_KEYS[value]), title: t(TOOL_TITLES[value]) }))}
        value={gesture.edit.tool}
        onChange={(tool) => setRoomGesture(ctx, (g) => ({ ...g, edit: initRoomEdit(tool) }))}
      />
      <BarAction
        onClick={() => { void runRoomAction('edit', { kind: 'prune' }); }}
        title={t('roomLayout.cleanup.title')}
        icon={<Eraser aria-hidden className="h-3.5 w-3.5" />}
      >
        {t('roomLayout.cleanup.label')}
      </BarAction>
    </>
  );
}

const WELD_MIN = 0.05;
const WELD_MAX = 1;
const clampWeld = (v: number) => Math.min(WELD_MAX, Math.max(WELD_MIN, Math.round(v * 100) / 100));

/** More ▾: Footprint, Auto on every storey, the corner weld, leak diagnostics. */
export function RoomMoreMenu({ gesture, ctx, rooms }: CommandHudProps<RoomPlaceGesture> & { rooms: number }) {
  const { t, locale } = useTranslation();
  const weld = gesture.weld ?? DEFAULT_WELD;
  const setWeld = (value: number | null) => setRoomGesture(ctx, (g) => ({ ...g, weld: value, hover: null, edit: initRoomEdit(g.edit.tool) }));
  return (
    <HudPopover>
      <HudPopoverTrigger asChild>
        <button
          type="button"
          title={t('roomLayout.more.title')}
          data-room-more
          className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {t('roomLayout.more.label')}
          <ChevronDown aria-hidden className="h-3 w-3" />
        </button>
      </HudPopoverTrigger>
      <HudPopoverContent align="end" className="flex w-64 flex-col gap-1.5">
        <BarAction onClick={() => { void runRoomAction('footprint'); }} title={t('roomLayout.footprint.title')} icon={<SquareDashed aria-hidden className="h-3.5 w-3.5" />}>
          {t('roomLayout.footprint.label')}
        </BarAction>
        <BarAction onClick={() => { void runRoomAction('autoAll'); }} title={t('roomLayout.autoAll.title')} icon={<Building2 aria-hidden className="h-3.5 w-3.5" />}>
          {t('roomLayout.autoAll.label')}
        </BarAction>
        <div className="flex flex-col gap-1 border-t border-border pt-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-foreground" title={t('roomLayout.weld.title')}>{t('roomLayout.weld.label')}</span>
            <span className="tabular-nums text-muted-foreground" data-room-weld-rooms>
              {t('roomLayout.weld.rooms', { count: rooms, countDisplay: formatLocaleNumber(locale, rooms) })}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="range" min={WELD_MIN} max={WELD_MAX} step={0.05} value={weld}
              aria-label={t('roomLayout.weld.aria')}
              className="flex-1 accent-overlay-accent"
              onChange={(e) => setWeld(clampWeld(Number(e.target.value)))}
            />
            <input
              type="number" min={WELD_MIN} max={WELD_MAX} step={0.05} value={weld}
              aria-label={t('roomLayout.weld.aria')}
              className="w-14 rounded-sm border border-border bg-background px-1 text-right tabular-nums"
              onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) setWeld(clampWeld(v)); }}
            />
            <button
              type="button"
              className="rounded-sm px-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
              disabled={gesture.weld === null}
              title={gesture.weld === null ? t('roomLayout.weld.auto') : t('roomLayout.weld.reset')}
              aria-label={t('roomLayout.weld.reset')}
              onClick={() => setWeld(null)}
            >
              <RotateCcw aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="border-t border-border pt-1.5">
          <HudToggle
            pressed={gesture.leaks}
            onPressedChange={() => setRoomGesture(ctx, (g) => ({ ...g, leaks: !g.leaks }))}
            title={t('roomLayout.leaks.title')}
          >
            {t('roomLayout.leaks.label')}
          </HudToggle>
        </div>
      </HudPopoverContent>
    </HudPopover>
  );
}
