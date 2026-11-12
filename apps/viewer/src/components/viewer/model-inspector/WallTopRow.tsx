/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A selected wall's top (#9013): attached to the storey above (it follows
 * that storey when storeys are re-levelled) or a fixed height. Attaching
 * makes the wall reach the storey above; both changes are one undo step.
 */

import { useEffect, useMemo, useState } from 'react';
import { parsePropertyValue } from '@ifc-lite/encoding';
import { NEXT_STOREY_ABOVE, STOREY_ATTACHMENT_PSET, readStoreyInventory, readTopAttachment } from '@ifc-lite/create';
import { useViewerStore, resolveEntityRef } from '@/store';
import { useTranslation } from '@/i18n';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { WallTop } from '@/store/slices/authoringDefaultsSlice';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
import { CommitField, InspectorRow } from './InspectorControls';
import { setWallDimensions } from './inspector-edits';
import { attachWallTop, wallOffsets, setWallOffset } from './wall-constraint-edits';
import { useWallTopPick, cancelWallTopPick } from '@/lib/wall-top-pick';

export function readWallTop(modelId: string, wallId: number): { top: WallTop | 'element'; target: { text: string; raw: string; from?: string } | null } {
  const s = useViewerStore.getState();
  const target = modelEditTarget(s, modelId);
  if (!target) return { top: 'fixed', target: null };
  const inventory = readStoreyInventory(target.dataStore, target.view);
  const raw = target.view.getPropertyValue(wallId, STOREY_ATTACHMENT_PSET, 'TopConstraint');
  const attachment = readTopAttachment(inventory, wallId);
  if (attachment?.kind === 'element' && attachment.targetElementId !== undefined) {
    const entity = inventory.reader.entity(attachment.targetElementId);
    const name = String(entity?.attributes[2] ?? `#${attachment.targetElementId}`);
    const label = entity?.type.toUpperCase() === 'IFCROOF' ? 'Roof' : 'Slab';
    return { top: 'element', target: { text: `${label} '${name}' underside`, raw: String(entity?.attributes[0]), from: name } };
  }
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
  return attachWallTop(modelId, wallId, { kind: top });
}

export function WallTopRow({ modelId, wallId }: { modelId: string; wallId: number }) {
  const { t } = useTranslation();
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const { top, target } = useMemo(() => { void mutationVersion; return readWallTop(modelId, wallId); }, [modelId, wallId, mutationVersion, t]);
  const [error, setError] = useState('');
  const owner = `${modelId}:${wallId}`;
  const picking = useWallTopPick(s => s.owner === owner);
  const offsets = wallOffsets(modelId, wallId);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && useWallTopPick.getState().owner === owner) {
        event.preventDefault(); event.stopImmediatePropagation(); cancelWallTopPick();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      if (useWallTopPick.getState().owner === owner) cancelWallTopPick();
    };
  }, [owner]);
  const pick = () => {
    setError('');
    useViewerStore.getState().setActiveTool('select');
    useWallTopPick.setState({ owner, accept: globalId => {
      if (globalId === null) return;
      const ref = resolveEntityRef(globalId);
      if (ref.modelId !== modelId) { setError('Pick a slab or roof in the same model'); return; }
      const target = modelEditTarget(useViewerStore.getState(), modelId);
      const type = target?.editor.getEntityType(ref.expressId)?.toUpperCase();
      if (!type || !/^(IFCROOF|IFCSLAB|IFCSLABSTANDARDCASE|IFCSLABELEMENTEDCASE)$/.test(type)) {
        setError('Pick a slab or roof'); return;
      }
      if (attachWallTop(modelId, wallId, type === 'IFCROOF' ? { kind: 'roof', roofId: ref.expressId } : { kind: 'slab', slabId: ref.expressId }, setError)) cancelWallTopPick();
    } });
  };
  return (<>
    <InspectorRow label={t('modelingCommand.wall.top')}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <SegmentedControl
          size="sm"
          label={t('modelingCommand.wall.top')}
          value={picking ? 'element' : top}
          onValueChange={(next: WallTop | 'element') => { if (next === 'element') pick(); else { cancelWallTopPick(); setError(''); attachWallTop(modelId, wallId, { kind: next }, setError); } }}
          options={[
            { value: 'storeyAbove', label: t('modelingCommand.wall.topStoreyAbove') },
            { value: 'element', label: t('modelingCommand.wall.topElement') },
            { value: 'fixed', label: t('modelingCommand.wall.topFixed') },
          ]}
        />
        {target && <span title={target.raw} className="whitespace-normal break-words text-2xs leading-snug text-muted-foreground">{target.text}</span>}
      </div>
    </InspectorRow>
    {picking && <p role="status">{t('modelingCommand.wall.pickTop')}</p>}
    <InspectorRow label={t('modelingCommand.wall.topOffset')} htmlFor="wall-top-offset">
      <CommitField id="wall-top-offset" ariaLabel={t('modelingCommand.wall.topOffset')} value={offsets?.top?.toFixed(3) ?? ''} readOnly={offsets?.top == null}
        onCommit={text => setWallOffset(modelId, wallId, 'top', Number(text), setError)} />
    </InspectorRow>
    <InspectorRow label={t('modelingCommand.wall.baseOffset')} htmlFor="wall-base-offset">
      <CommitField id="wall-base-offset" ariaLabel={t('modelingCommand.wall.baseOffset')} value={offsets?.base.toFixed(3) ?? ''}
        onCommit={text => setWallOffset(modelId, wallId, 'base', Number(text), setError)} />
    </InspectorRow>
    {error && <p role="alert">{error}</p>}
    </>
  );
}
