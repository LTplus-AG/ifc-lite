/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read-only preview totals and layout diagnostics before Auto writes rooms (#6232/#6531). */
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import type { RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { roomOutline, sessionRooms, storeyWalls, type RoomCandidate } from '@/lib/rooms/storey-rooms';
import { DEFAULT_WELD } from '@/lib/rooms/room-layout';
import { wallLeaks } from '@/lib/rooms/room-leaks';
import { polyArea } from '@/lib/rooms/plate-geometry';

export function RoomCreationSummary({ gesture, ctx, rooms }: CommandHudProps<RoomPlaceGesture> & { rooms: readonly RoomCandidate[] }) {
  const { t, locale } = useTranslation();
  const free = rooms.filter((room) => !room.taken);
  const area = free.reduce((sum, room) => sum + polyArea(roomOutline(room, gesture.boundary)), 0);
  const walls = ctx.workplane && ctx.storeyId !== null ? storeyWalls(ctx.get(), ctx.modelId, ctx.storeyId, ctx.workplane) : [];
  const weld = gesture.weld ?? DEFAULT_WELD;
  const layout = sessionRooms(ctx, weld, 0);
  const allRooms = layout?.status === 'ready' ? layout.rooms : [];
  const leaks = wallLeaks(walls, allRooms, weld);
  const vertices = new Set<string>();
  const edges = new Set<string>();
  for (const room of allRooms) {
    const corners = room.centre.map((point) => point.join(','));
    corners.forEach((point, index) => {
      vertices.add(point);
      edges.add([point, corners[(index + 1) % corners.length]].sort().join('|'));
    });
  }
  const number = (value: number) => formatLocaleNumber(locale, value, { maximumFractionDigits: 2 });
  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-1.5 text-2xs text-muted-foreground" data-room-preview-summary>
      <p>{t('roomTool.preview.total', { countDisplay: number(free.length), area: number(area) })}</p>
      <p>{t('roomTool.preview.graph', { walls: number(walls.length), vertices: number(vertices.size), edges: number(edges.size) })}</p>
      <p>{t('roomTool.preview.leaks', { openEnds: number(leaks.openEnds.length), unboundedWalls: number(leaks.walls.filter((wall) => !wall.bounding).length) })}</p>
    </div>
  );
}
