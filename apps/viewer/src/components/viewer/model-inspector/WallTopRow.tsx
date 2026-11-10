/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A selected wall's top (#9013): attached to the storey above (it follows
 * that storey when storeys are re-levelled) or a fixed height. Attaching
 * makes the wall reach the storey above; both changes are one undo step.
 */

import { useMemo } from 'react';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { NEXT_STOREY_ABOVE, STOREY_ATTACHMENT_PSET, readStoreyInventory, readTopAttachment } from '@ifc-lite/create';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { commitElementSize } from '@/lib/element-size-commit';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { WallTop } from '@/store/slices/authoringDefaultsSlice';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
import { InspectorRow } from './InspectorControls';
import { runInspectorEdit, setWallDimensions } from './inspector-edits';
import { fixWallTop } from '@/lib/commands/modeling/wall-top-fix';
import { MIN_ATTACHED_HEIGHT } from '@/lib/commands/modeling/wall-top';

export function readWallTop(modelId: string, wallId: number): { top: WallTop; target: { text: string; raw: string; from?: string } | null } {
  const s = useViewerStore.getState();
  const target = modelEditTarget(s, modelId);
  if (!target) return { top: 'fixed', target: null };
  const inventory = readStoreyInventory(target.dataStore, target.view);
  const raw = target.view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint');
  const attachment = readTopAttachment(inventory, wallId);
  const constraint = parsePropertyValue(raw).displayValue;
  const value = raw ?? inventory.storeys.find(storey => storey.expressId === attachment?.targetStoreyId)?.GlobalId;
  const display = storeyAttachmentDisplay(s, modelId, wallId, value);
  // The shared resolver decodes typed IfcLabels before resolving a storey.
  const resolvedStorey = display?.from !== undefined;
  return { top: attachment || resolvedStorey || constraint === NEXT_STOREY_ABOVE ? 'storeyAbove' : 'fixed', target: constraint === 'Fixed' ? null : display ?? (raw !== null && raw !== undefined && raw !== '' ? { text: constraint, raw: constraint } : null) };
}

/**
 * A typed wall height, as the Wall tool's height field: the wall becomes
 * fixed-height in the same Undo step, so re-levelling a storey never
 * replaces the height that was typed.
 */
export function setWallHeightFixed(modelId: string, wallId: number, height: number): boolean {
  return setWallDimensions(modelId, wallId, { height });
}

/** Attach the wall to the storey above it (reaching it), or make it fixed-height. */
export function setWallTop(modelId: string, wallId: number, top: WallTop): boolean {
  return runInspectorEdit(modelId, (tx) => {
    const s = tx.store;
    if (top === 'fixed') {
      fixWallTop(tx, modelId, wallId);
      return [];
    }
    const store = s.models.get(modelId)?.ifcDataStore;
    const storeyId = store ? effectiveStoreyId(store, s.mutationViews.get(modelId), wallId) : undefined;
    const storeys = modelStoreys(s, modelId);
    const index = storeys.findIndex((storey) => storey.expressId === storeyId);
    const above = index >= 0 ? storeys[index + 1] : undefined;
    const wall = s.readWallEndpoints(modelId, wallId);
    if (index < 0 || !wall) throw new Error(`Wall #${wallId} is not on a storey`);
    let remesh: readonly number[] = [];
    let attachTo = NEXT_STOREY_ABOVE;
    if (above) {
      const guid = s.mutationViews.get(modelId)?.getNewEntity(above.expressId)?.attributes[0] ?? store?.entities.getGlobalId(above.expressId);
      if (typeof guid !== 'string' || !guid) throw new Error(`The storey above has no GlobalId`);
      attachTo = guid;
      const height = above.elevation - storeys[index].elevation - wall.start[2];
      // As the Wall tool (`resolveWallTop`): a wall that would be a sliver stays fixed-height.
      if (height < MIN_ATTACHED_HEIGHT) throw new Error(`Wall #${wallId} would reach the storey above at under ${MIN_ATTACHED_HEIGHT} m: it stays fixed-height`);
      if (Math.abs(height - wall.height) > 1e-6) {
        const outcome = commitElementSize(useViewerStore, modelId, wallId, { kind: 'wall', height });
        if (!outcome.ok) throw new Error(outcome.reason);
        remesh = outcome.remesh;
      }
    }
    if (!s.setProperty(modelId, wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint', attachTo, PropertyValueType.Label)) {
      throw new Error(`Couldn't record the top of wall #${wallId}`);
    }
    return remesh;
  });
}

export function WallTopRow({ modelId, wallId }: { modelId: string; wallId: number }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { top, target } = useMemo(() => { void mutationVersion; return readWallTop(modelId, wallId); }, [modelId, wallId, mutationVersion, t]);
  return (
    <InspectorRow label={t('modelingCommand.wall.top')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <SegmentedControl
          size="sm"
          label={t('modelingCommand.wall.top')}
          value={top}
          onValueChange={(next: WallTop) => { if (next !== top) setWallTop(modelId, wallId, next); }}
          options={[
            { value: 'storeyAbove', label: t('modelingCommand.wall.topStoreyAbove') },
            { value: 'fixed', label: t('modelingCommand.wall.topFixed') },
          ]}
        />
        {target && <span title={target.raw} className="whitespace-normal break-words text-2xs leading-snug text-muted-foreground">{target.text}</span>}
      </div>
    </InspectorRow>
  );
}
