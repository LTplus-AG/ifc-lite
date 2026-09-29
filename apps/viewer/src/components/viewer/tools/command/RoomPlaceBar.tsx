/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s bar controls (charter #6232 M4), after its Height field:
 * Pick / Draw, which wall face derived rooms follow, and the two actions.
 * Auto makes every face of the storey that has no room yet a room; Update
 * rooms re-derives the selected rooms from the current walls (decision D5).
 * Each action commits through the running command, so it is one undo step.
 */

import { RefreshCw, Wand2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { useViewerStore } from '@/store';
import { commitCommand, notifyCommandRefusal, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import { resolve as translate } from '@/i18n/registry';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { ensureSpaceWasm } from '@/lib/space-plate-session';
import type { RoomBoundary } from '@/lib/rooms/storey-rooms';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import { initSlabGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import { selectedRooms } from '@/lib/rooms/room-writes';
import { initRoomGesture, type RoomAction, type RoomMode, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { HudDivider, HudSegmented } from '../../../viewport-ui/hud';
import { useSessionRooms } from './RoomPlaceLayers';

const MODE_KEYS: Record<RoomMode, TranslationKey> = {
  pick: 'roomTool.mode.pick',
  draw: 'roomTool.mode.draw',
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

/** Run one of the bar's actions as a commit of the running command. */
export async function runRoomAction(action: Exclude<RoomAction, 'place'>): Promise<void> {
  try {
    await ensureSpaceWasm();
  } catch (error) {
    console.error('[room.place] space wasm failed to load', error);
    notifyCommandRefusal(translate('roomTool.wasmFailed'));
    return;
  }
  updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), action }));
  commitCommand();
  // A refused action leaves the gesture as it was; the next click places again.
  updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), action: 'place' }));
}

function BarAction({ onClick, disabled, title, icon, children }: {
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

export function RoomPlaceBar({ gesture, ctx }: CommandHudProps<RoomPlaceGesture>) {
  const { t, locale } = useTranslation();
  const rooms = useSessionRooms(ctx);
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
        options={options(['pick', 'draw'] as const, MODE_KEYS)}
        value={gesture.mode}
        onChange={(mode) => updateCommandGesture(() => initRoomGesture(mode, gesture.boundary, gesture.draw.mode))}
      />
      {gesture.mode === 'draw' && (
        <HudSegmented
          aria-label={t('modelingCommand.slab.mode')}
          options={options(['rectangle', 'polygon'] as const, DRAW_KEYS)}
          value={gesture.draw.mode}
          onChange={(drawMode) => {
            setDefaults({ spaceMode: drawMode });
            // A half-drawn outline of the other kind means nothing in this one.
            updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), draw: initSlabGesture(drawMode) }));
          }}
        />
      )}
      <HudDivider />
      <HudSegmented
        aria-label={t('roomTool.boundary.label')}
        options={options(['inner', 'center', 'outer'] as const, BOUNDARY_KEYS)}
        value={gesture.boundary}
        onChange={(boundary) => updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), boundary }))}
      />
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
    </>
  );
}
