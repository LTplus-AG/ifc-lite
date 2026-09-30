/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s bar controls (charter #6232 M4), after its Height field:
 * Pick / Draw / Edit, which wall face derived rooms follow (Edit: its two
 * tools instead, `RoomLayoutBar`), and the actions. Auto makes every face of
 * the storey that has no room yet a room; Update rooms re-derives the
 * selected rooms from the current walls (decision D5); More holds Footprint,
 * Auto on every storey, the corner weld and leak diagnostics. Each action
 * commits through the running command, so it is one undo step.
 */

import { RefreshCw, Wand2 } from 'lucide-react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { RoomBoundary } from '@/lib/rooms/storey-rooms';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import { initSlabGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import { selectedRooms } from '@/lib/rooms/room-writes';
import { initRoomGesture, roomSettings, type RoomMode, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';
import { useSessionRooms } from './RoomPlaceLayers';
import { RoomEditTools, RoomMoreMenu } from './RoomLayoutBar';
import { BarAction, runRoomAction, setRoomGesture } from './RoomBarActions';

export { runRoomAction };

const MODE_KEYS: Record<RoomMode, TranslationKey> = {
  pick: 'roomTool.mode.pick',
  draw: 'roomTool.mode.draw',
  edit: 'roomLayout.mode.edit',
};
const DRAW_KEYS: Record<SlabDrawMode, TranslationKey> = {
  rectangle: 'modelingCommand.slab.rectangle',
  polygon: 'modelingCommand.slab.polygon',
};
const BOUNDARY_KEYS: Record<RoomBoundary, TranslationKey> = {
  inner: 'roomTool.boundary.inner',
  center: 'roomTool.boundary.center',
  outer: 'roomTool.boundary.outer',
};

export function RoomPlaceBar({ gesture, ctx }: CommandHudProps<RoomPlaceGesture>) {
  const { t, locale } = useTranslation();
  const rooms = useSessionRooms(ctx, gesture.weld, gesture.minArea);
  const selected = useViewerStore((s) => selectedRooms(s, ctx.modelId).length);
  const setDefaults = useViewerStore((s) => s.setAuthoringDefaults);
  const free = rooms.filter((r) => !r.taken).length;
  const options = <T extends string>(values: readonly T[], keys: Record<T, TranslationKey>) =>
    values.map((value) => ({ value, label: t(keys[value]) }));
  return (
    <>
      <HudDivider />
      <HudSegmented
        aria-label={t('roomTool.mode.label')}
        options={options(['pick', 'draw', 'edit'] as const, MODE_KEYS)}
        value={gesture.mode}
        onChange={(mode) => setRoomGesture(ctx, (g) => initRoomGesture(mode, roomSettings(g)))}
      />
      {gesture.mode === 'draw' && (
        <HudSegmented
          aria-label={t('modelingCommand.slab.mode')}
          options={options(['rectangle', 'polygon'] as const, DRAW_KEYS)}
          value={gesture.draw.mode}
          onChange={(drawMode) => {
            setDefaults({ spaceMode: drawMode });
            // A half-drawn outline of the other kind means nothing in this one.
            setRoomGesture(ctx, (g) => ({ ...g, draw: initSlabGesture(drawMode) }));
          }}
        />
      )}
      <HudDivider />
      {gesture.mode === 'edit' ? <RoomEditTools gesture={gesture} ctx={ctx} /> : (
        <HudSegmented
          aria-label={t('roomTool.boundary.label')}
          options={options(['inner', 'center', 'outer'] as const, BOUNDARY_KEYS)}
          value={gesture.boundary}
          onChange={(boundary) => setRoomGesture(ctx, (g) => ({ ...g, boundary }))}
        />
      )}
      <HudDivider />
      <BarAction
        onClick={() => { void runRoomAction('auto'); }}
        disabled={free === 0}
        title={t('roomTool.auto.title')}
        icon={<Wand2 aria-hidden className="h-3.5 w-3.5" />}
      >
        {t('roomTool.auto.label', { countDisplay: formatLocaleNumber(locale, free) })}
      </BarAction>
      <BarAction
        onClick={() => { void runRoomAction('update'); }}
        disabled={selected === 0}
        title={t('roomTool.update.title')}
        icon={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}
      >
        {t('roomTool.update.label')}
      </BarAction>
      <RoomMoreMenu gesture={gesture} ctx={ctx} rooms={rooms} />
    </>
  );
}
