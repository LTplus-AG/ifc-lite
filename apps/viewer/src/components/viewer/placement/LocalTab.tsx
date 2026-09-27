/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `placement` side panel's Local tab (#5505): the form the floating
 * `RepositionPanel` used to draw over the canvas (`absolute top-32 right-4`).
 * The scene overlay (gizmo + hover marker) and all of the session's local
 * state now live in `RepositionRuntimeHost` (mounted by `ToolOverlays`,
 * unconditionally alongside the select tool); this tab only reads and drives
 * that state through `useRepositionRuntime()`, plus the store fields it
 * already shares with every other panel (`modelPlacement`, `models`,
 * `snapEnabled`).
 */
import { useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import type { MoveConstraint } from '@/lib/model-placement/translation';
import { frameModels } from '@/lib/model-placement/scene';
import { useRepositionRuntime, type RepositionRuntime } from '@/lib/model-placement/reposition-runtime';
import { openRepositionModels } from '@/lib/model-placement/commands';
import { RotationControls } from '../reposition/RotationControls';
import { PlacementFiles } from '../reposition/PlacementFiles';

const PICK_ROLE_KEYS: Record<'source' | 'target', TranslationKey> = {
  source: 'repositionPanel.pickRoleSource',
  target: 'repositionPanel.pickRoleTarget',
};
const HOVER_KIND_KEYS: Record<'vertex' | 'edge' | 'face' | 'point' | 'origin' | 'bounds', TranslationKey> = {
  vertex: 'repositionPanel.hoverKindVertex',
  edge: 'repositionPanel.hoverKindEdge',
  face: 'repositionPanel.hoverKindFace',
  point: 'repositionPanel.hoverKindPoint',
  origin: 'repositionPanel.hoverKindOrigin',
  bounds: 'repositionPanel.hoverKindBounds',
};
const AXES = ['X', 'Y', 'Z'] as const;
const CONSTRAINTS = ['free', 'x', 'y', 'z', 'xy', 'xz', 'yz'] as const;

/** Camera-framing shortcuts, kept out of the `run()`-wrapped preview/apply
 * flow: a bad bounds lookup shows up here, not against the move preview. */
function frame(runtime: RepositionRuntime, ids: readonly string[]) {
  try { frameModels(ids); }
  catch (err) { runtime.setError(err instanceof Error ? err.message : String(err)); }
}

export function LocalTab() {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const placement = useViewerStore((s) => s.modelPlacement);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const repositionOpen = useViewerStore((s) => s.repositionOpen);
  const runtime = useRepositionRuntime();
  const [pending, setPending] = useState<readonly string[]>([]);

  if (!repositionOpen || !runtime) {
    return (
      <div className="flex flex-col gap-2 text-xs">
        <p className="text-2xs uppercase tracking-wider text-muted-foreground">{t('placementPanel.local.emptyTitle')}</p>
        <p className="text-2xs leading-snug text-muted-foreground">{t('placementPanel.local.emptyHint')}</p>
        <div className="space-y-1">
          {[...models].map(([id, model]) => (
            <label key={id} className="flex items-center justify-between gap-2">
              <span className="truncate">{model.name}</span>
              <Switch
                checked={pending.includes(id)}
                onCheckedChange={(checked) => setPending((prev) => (checked ? [...prev, id] : prev.filter((item) => item !== id)))}
                aria-label={model.name}
              />
            </label>
          ))}
        </div>
        <Button size="sm" onClick={() => openRepositionModels(pending.length > 0 ? pending : undefined)}>
          {t('placementPanel.local.startButton')}
        </Button>
      </div>
    );
  }

  const preview = placement.preview;
  const delta = preview?.delta ?? [0, 0, 0];

  return (
    <section aria-label={t('repositionPanel.title')} className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground">{t('repositionPanel.subtitle')}</p>
        <Button size="sm" variant="outline" aria-label={t('repositionPanel.cancelAriaLabel')} onClick={() => useViewerStore.getState().closeReposition()}>
          {t('repositionPanel.cancelButton')}
        </Button>
      </div>

      <fieldset className="space-y-1">
        <legend className="font-medium">{t('repositionPanel.movingModelsLegend')}</legend>
        {[...models].map(([id, model]) => (
          <div className="flex gap-2 items-center" key={id}>
            <span className="flex-1 truncate">{model.name}</span>
            <Switch
              checked={runtime.selected.includes(id)}
              onCheckedChange={(checked) => {
                runtime.chooseModels(checked ? [...runtime.selected, id] : runtime.selected.filter((item) => item !== id));
              }}
              aria-label={model.name}
            />
            <Button
              size="sm" variant="outline"
              aria-label={t('repositionPanel.toggleLockAriaLabel', {
                action: t(placementFor(placement, id).locked ? 'repositionPanel.unlockAction' : 'repositionPanel.lockAction'),
                name: model.name,
              })}
              onClick={() => useViewerStore.getState().setModelPositionLocked(id, !placementFor(placement, id).locked)}
            >
              {t(placementFor(placement, id).locked ? 'repositionPanel.statusLocked' : 'repositionPanel.statusUnlocked')}
            </Button>
          </div>
        ))}
      </fieldset>

      <label className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">{t('repositionPanel.referenceModelLabel')}</span>
        <Select value={runtime.reference || undefined} onValueChange={runtime.setReference}>
          <SelectTrigger aria-label={t('repositionPanel.referenceModelLabel')}><SelectValue placeholder={t('repositionPanel.chooseReferenceOption')} /></SelectTrigger>
          <SelectContent>
            {[...models].filter(([id]) => !runtime.selected.includes(id)).map(([id, model]) => (
              <SelectItem key={id} value={id}>{model.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={() => frame(runtime, runtime.selected)}>{t('repositionPanel.frameMovingButton')}</Button>
        <Button size="sm" variant="outline" disabled={!runtime.reference} onClick={() => frame(runtime, [runtime.reference])}>{t('repositionPanel.frameReferenceButton')}</Button>
        <Button size="sm" variant="outline" disabled={!runtime.reference} onClick={() => frame(runtime, [...runtime.selected, runtime.reference])}>{t('repositionPanel.frameBothButton')}</Button>
        <Button size="sm" variant="outline" disabled={!runtime.reference} onClick={runtime.nearReference}>{t('repositionPanel.moveNearReferenceButton')}</Button>
      </div>
      <p className="text-muted-foreground">{t('repositionPanel.moveNearNote')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => runtime.setRole('source')}>{t('repositionPanel.pickSourceButton')}</Button>
        <Button size="sm" variant="outline" disabled={!preview?.source} onClick={() => runtime.setRole('target')}>{t('repositionPanel.pickTargetButton')}</Button>
        <label className="flex items-center gap-1.5">
          <Switch checked={snapEnabled} onCheckedChange={() => useViewerStore.getState().toggleSnap()} aria-label={t('repositionPanel.snapLabel')} />
          <span>{t('repositionPanel.snapLabel')}</span>
        </label>
      </div>
      <output className="block">
        {runtime.role ? t('repositionPanel.pickPrompt', { role: t(PICK_ROLE_KEYS[runtime.role]) }) : t('repositionPanel.previewPrompt')}
        {runtime.hover ? ` ${t('repositionPanel.hoverDetail', { kind: t(HOVER_KIND_KEYS[runtime.hover.kind]), name: models.get(runtime.hover.modelId)?.name ?? '' })}` : ''}
      </output>

      <label className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">{t('repositionPanel.constraintLabel')}</span>
        <Select value={preview?.constraint ?? 'free'} onValueChange={(value) => useViewerStore.getState().setMoveConstraint(value as MoveConstraint)}>
          <SelectTrigger aria-label={t('repositionPanel.movementConstraintAriaLabel')}><SelectValue /></SelectTrigger>
          <SelectContent>{CONSTRAINTS.map((value) => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">{t('repositionPanel.inputLabel')}</span>
        <Select value={runtime.mode} onValueChange={(value) => runtime.setMode(value as 'delta' | 'absolute')}>
          <SelectTrigger aria-label={t('repositionPanel.coordinateInputModeAriaLabel')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="delta">{t('repositionPanel.deltaModeOption')}</SelectItem>
            <SelectItem value="absolute">{t('repositionPanel.absoluteModeOption')}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <div className="grid grid-cols-3 gap-1">
        {AXES.map((axis, i) => (
          <label key={axis} className="flex flex-col gap-0.5">
            <span>{runtime.mode === 'delta' ? t('repositionPanel.deltaPrefix') : ''}{axis}</span>
            <Input
              aria-label={t(runtime.mode === 'delta' ? 'repositionPanel.axisFieldDeltaAriaLabel' : 'repositionPanel.axisFieldSourceAriaLabel', { axis })}
              className="font-mono" value={runtime.fields[i]} onChange={(e) => runtime.setFieldAt(i, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runtime.previewFields(); } }}
            />
          </label>
        ))}
      </div>
      <Button size="sm" variant="outline" onClick={runtime.previewFields}>{t('repositionPanel.previewValuesButton')}</Button>

      <label className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">{t('repositionPanel.distanceLabel')}</span>
        <Input aria-label={t('repositionPanel.moveDistanceAriaLabel')} className="w-24" value={runtime.distance}
          onChange={(e) => runtime.setDistance(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runtime.previewDistance(); } }} />
      </label>
      <Button size="sm" variant="outline" onClick={runtime.previewDistance}>{t('repositionPanel.previewDistanceButton')}</Button>

      <output aria-label={t('repositionPanel.moveDimensionsAriaLabel')} className="block font-mono">
        {t('repositionPanel.moveOutput', { distance: Math.hypot(...delta).toFixed(4), dx: delta[0].toFixed(4), dy: delta[1].toFixed(4), dz: delta[2].toFixed(4) })}
      </output>

      <label className="flex flex-col gap-0.5">
        <span className="text-2xs uppercase tracking-wider text-muted-foreground">{t('repositionPanel.nudgeIncrementLabel')}</span>
        <Input aria-label={t('repositionPanel.nudgeIncrementLabel')} className="w-24" value={runtime.nudgeField}
          onChange={(e) => runtime.setNudgeField(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runtime.applyNudge(); } }}
          onBlur={runtime.applyNudge} />
      </label>
      <p className="text-muted-foreground">{t('repositionPanel.keyboardHelp')}</p>

      {runtime.selected.map((id) => (
        <p key={id} className="font-mono truncate">
          {t('repositionPanel.modelPositionRow', { name: models.get(id)?.name ?? '', values: displayedTranslation(placement, id).map((v) => v.toFixed(4)).join(', ') })}
        </p>
      ))}

      <RotationControls selected={runtime.selected} onError={runtime.setError} />
      {runtime.error && <p role="alert" className="text-destructive">{runtime.error}</p>}

      <div className="flex flex-wrap gap-1">
        <Button size="sm" disabled={!preview} onClick={runtime.apply}>{t('repositionPanel.applyButton')}</Button>
        <Button size="sm" variant="outline" disabled={!placement.undo.length} onClick={() => useViewerStore.getState().undoModelTranslation()}>{t('repositionPanel.undoButton')}</Button>
        <Button size="sm" variant="outline" disabled={!placement.redo.length} onClick={() => useViewerStore.getState().redoModelTranslation()}>{t('repositionPanel.redoButton')}</Button>
        <Button size="sm" variant="outline" onClick={() => useViewerStore.getState().resetModelTranslations(runtime.selected)}>{t('repositionPanel.resetButton')}</Button>
      </div>

      <PlacementFiles />
    </section>
  );
}
