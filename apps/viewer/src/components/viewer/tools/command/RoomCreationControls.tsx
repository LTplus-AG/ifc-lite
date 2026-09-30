/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Room creation settings retained when the old panel is removed (#6232/#6531). */
import { useState } from 'react';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import type { CommandHudProps } from '@/lib/commands/modeling/types';
import { initRoomEdit, type RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { setRoomGesture } from './RoomBarActions';

/** The occurrence's actual classification attribute and values, from EXPRESS. */
export function roomClassification(schema: string) {
  const version = schema === 'IFC2X3' || schema === 'IFC4X3' ? schema : 'IFC4';
  const registry = getSchemaRegistryForVersion(version);
  const attribute = registry.entities.IfcSpace.allAttributes![9];
  return { name: attribute.name, values: registry.enums[attribute.type] };
}

const inputClass = 'min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs';

export function RoomCreationControls({ gesture, ctx }: CommandHudProps<RoomPlaceGesture>) {
  const { t } = useTranslation();
  const [area, setArea] = useState<string | null>(null);
  const schema = ctx.get().models.get(ctx.modelId)?.ifcDataStore?.schemaVersion ?? 'IFC4';
  const classification = roomClassification(schema);
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-1.5" data-room-creation-options>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('roomTool.options.minArea')}</span>
        <input
          className={inputClass} type="number" min={0.001} step={0.1} value={area ?? gesture.minArea}
          onChange={(event) => setArea(event.target.value)}
          onBlur={() => {
            const value = Number(area);
            if (area !== null && area.trim() && Number.isFinite(value) && value > 0) {
              setRoomGesture(ctx, (g) => ({ ...g, minArea: value, hover: null, edit: initRoomEdit(g.edit.tool) }));
            }
            setArea(null);
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); event.currentTarget.blur(); } }}
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('roomTool.options.namePattern')}</span>
        <input className={inputClass} value={gesture.namePattern} onChange={(event) => setRoomGesture(ctx, (g) => ({ ...g, namePattern: event.target.value }))} />
      </label>
      <p className="text-2xs text-muted-foreground">{t('roomTool.options.nameHint', { token: '{n}' })}</p>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span>{t('roomTool.options.classification', { attribute: classification.name })}</span>
        <select className={inputClass} value={gesture.PredefinedType} onChange={(event) => setRoomGesture(ctx, (g) => ({ ...g, PredefinedType: event.target.value }))}>
          {!classification.values.includes(gesture.PredefinedType) && <option value={gesture.PredefinedType} disabled>{gesture.PredefinedType}</option>}
          {classification.values.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      {gesture.PredefinedType === 'USERDEFINED' && (
        <label className="flex items-center justify-between gap-2 text-xs">
          <span>{t('roomTool.options.objectType')}</span>
          <input className={inputClass} value={gesture.ObjectType} onChange={(event) => setRoomGesture(ctx, (g) => ({ ...g, ObjectType: event.target.value }))} />
        </label>
      )}
    </div>
  );
}
