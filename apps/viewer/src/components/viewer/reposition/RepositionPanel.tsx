/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { isTextEntryTarget } from '@/lib/keyboard-event';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { addTranslation, subtractTranslation, parseMoveLength, toRenderTranslation, translationAtDistance,
  type Translation, type MoveConstraint } from '@/lib/model-placement/translation';
import { frameModels, modelCenter } from '@/lib/model-placement/scene';
import type { PlacementAnchor } from '@/lib/model-placement/state';
import { useRepositionPicking, type PickRole } from './useRepositionPicking';

import { PlacementFiles } from './PlacementFiles';
import { PlacementGizmo } from './PlacementGizmo';
import { RotationControls } from './RotationControls';

const AXES = ['X', 'Y', 'Z'] as const;
const button = 'border px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40';

const PICK_ROLE_KEYS: Record<'source' | 'target', TranslationKey> = {
  source: 'repositionPanel.pickRoleSource',
  target: 'repositionPanel.pickRoleTarget',
};
const HOVER_KIND_KEYS: Record<PlacementAnchor['kind'], TranslationKey> = {
  vertex: 'repositionPanel.hoverKindVertex',
  edge: 'repositionPanel.hoverKindEdge',
  face: 'repositionPanel.hoverKindFace',
  point: 'repositionPanel.hoverKindPoint',
  origin: 'repositionPanel.hoverKindOrigin',
  bounds: 'repositionPanel.hoverKindBounds',
};

export function RepositionPanel() {
  const { t } = useTranslation();
  const models = useViewerStore((s) => s.models);
  const placement = useViewerStore((s) => s.modelPlacement);
  const nudge = useViewerStore((s) => s.repositionNudge);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const project = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const [selected, setSelected] = useState<readonly string[]>(placement.preview?.modelIds ?? []);
  const [reference, setReference] = useState([...models.keys()].find((id) => !selected.includes(id)) ?? '');
  const [fields, setFields] = useState(['0', '0', '0']);
  const [mode, setMode] = useState<'delta' | 'absolute'>('delta');
  const [nudgeField, setNudgeField] = useState(`${nudge} m`);
  const [error, setError] = useState('');
  const [distance, setDistance] = useState('');
  const [role, setRole] = useState<PickRole>(null);
  const hover = useRepositionPicking(role, setRole, setError, reference);
  const preview = placement.preview;
  const delta = preview?.delta ?? [0, 0, 0];
  const run = useCallback((action: () => void) => {
    try { action(); setError(''); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  const ensurePreview = useCallback(() => {
    if (!useViewerStore.getState().modelPlacement.preview) useViewerStore.getState().openReposition(selected);
  }, [selected]);
  const apply = useCallback(() => run(() => {
    const state = useViewerStore.getState();
    state.applyModelTranslation();
    state.openReposition(selected);
    setRole(null);
  }), [run, selected]);

  useEffect(() => {
    const value = mode === 'absolute' && preview?.source ? addTranslation(preview.source.point, delta) : delta;
    setFields(value.map((component) => String(component)));
  }, [delta[0], delta[1], delta[2], mode, preview?.source]);

  useEffect(() => {
    if (selected.some((id) => !models.has(id))) { useViewerStore.getState().closeReposition(); return; }
    if (preview) setSelected(preview.modelIds);
    const moving = preview?.modelIds ?? selected;
    if (moving.includes(reference) || (reference && !models.has(reference))) {
      setReference([...models.keys()].find((id) => !moving.includes(id)) ?? '');
    }
  }, [preview?.modelIds, models, reference, selected]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); useViewerStore.getState().closeReposition(); return;
      }
      const target = event.target;
      if (isTextEntryTarget(event) || (target instanceof HTMLElement && target.closest('button, summary, a[href], [role=button]'))) return;
      const state = useViewerStore.getState();
      if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); apply(); }
      else if (!event.ctrlKey && !event.metaKey && ['x', 'y', 'z'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation(); ensurePreview();
        state.setMoveConstraint(event.key.toLowerCase() as MoveConstraint);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopImmediatePropagation();
        run(() => {
          ensurePreview();
          const current = useViewerStore.getState().modelPlacement.preview!;
          if (!['x', 'y', 'z'].includes(current.constraint)) throw new Error('Choose X, Y, or Z before nudging.');
          const axis = ['x', 'y', 'z'].indexOf(current.constraint);
          const step: [number, number, number] = [0, 0, 0];
          step[axis] = state.repositionNudge * (event.key === 'ArrowUp' ? 1 : -1);
          state.previewModelTranslation(addTranslation(current.delta, step));
        });
      }
    };
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [apply, ensurePreview, run]);

  const chooseModels = (ids: readonly string[]) => run(() => {
    useViewerStore.getState().openReposition(ids); setSelected(ids); setRole(null);
    if (ids.includes(reference)) setReference([...models.keys()].find((id) => !ids.includes(id)) ?? '');
  });
  const previewFields = () => run(() => {
    ensurePreview();
    const value: Translation = [parseMoveLength(fields[0]), parseMoveLength(fields[1]), parseMoveLength(fields[2])];
    let next = value;
    if (mode === 'absolute') {
      const source = useViewerStore.getState().modelPlacement.preview?.source;
      if (!source) throw new Error('Pick a source reference point before setting its coordinates.');
      next = subtractTranslation(value, source.point);
    }
    useViewerStore.getState().previewModelTranslation(next);
  });
  const previewDistance = () => run(() => {
    ensurePreview();
    const current = useViewerStore.getState().modelPlacement.preview!;
    const axis = ['x', 'y', 'z'].indexOf(current.constraint);
    const direction: Translation = axis < 0 ? current.delta : [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    useViewerStore.getState().previewModelTranslation(translationAtDistance(direction, parseMoveLength(distance)));
  });
  const nearReference = () => run(() => {
    ensurePreview();
    const source = modelCenter(selected[0]), target = modelCenter(reference);
    if (!source || !target) throw new Error('Both models need available bounds.');
    const prior = useViewerStore.getState().modelPlacement.preview!.delta;
    useViewerStore.getState().previewModelTranslation(addTranslation(prior, subtractTranslation(target, source)));
  });
  const projected = hover && project ? (() => {
    const [x, y, z] = toRenderTranslation(hover.point); return project({ x, y, z });
  })() : null;

  return <>
    <PlacementGizmo disabled={role !== null} onError={setError} />
    {projected && <div aria-hidden className="absolute pointer-events-none z-40 border-2 border-teal-500 rounded-full w-3 h-3"
      style={{ left: projected.x - 6, top: projected.y - 6 }} />}
    <section aria-label={t('repositionPanel.title')} className="absolute top-32 right-4 z-40 w-80 max-h-[calc(100%-9rem)] overflow-auto border bg-white dark:bg-zinc-950 shadow-lg p-3 space-y-3 text-xs"
      onPointerDown={(event) => event.stopPropagation()}>
      <div className="sticky top-0 z-10 bg-white dark:bg-zinc-950 flex justify-between items-center"><strong>{t('repositionPanel.title')}</strong>
        <button className={button} aria-label={t('repositionPanel.cancelAriaLabel')} onClick={() => useViewerStore.getState().closeReposition()}>{t('repositionPanel.cancelButton')}</button></div>
      <p>{t('repositionPanel.subtitle')}</p>
      <fieldset className="space-y-1"><legend className="font-medium">{t('repositionPanel.movingModelsLegend')}</legend>
        {[...models].map(([id, model]) => <div className="flex gap-2 items-center" key={id}>
          <label className="flex-1 truncate"><input type="checkbox" checked={selected.includes(id)}
            onChange={(event) => chooseModels(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} /> {model.name}</label>
          <button className={button} aria-label={t('repositionPanel.toggleLockAriaLabel', {
            action: t(placementFor(placement, id).locked ? 'repositionPanel.unlockAction' : 'repositionPanel.lockAction'),
            name: model.name,
          })}
            onClick={() => useViewerStore.getState().setModelPositionLocked(id, !placementFor(placement, id).locked)}>
            {t(placementFor(placement, id).locked ? 'repositionPanel.statusLocked' : 'repositionPanel.statusUnlocked')}</button>
        </div>)}
      </fieldset>
      <label className="block">{t('repositionPanel.referenceModelLabel')}<select aria-label={t('repositionPanel.referenceModelLabel')} className="border w-full bg-transparent p-1" value={reference} onChange={(e) => setReference(e.target.value)}>
        <option value="">{t('repositionPanel.chooseReferenceOption')}</option>{[...models].filter(([id]) => !selected.includes(id)).map(([id, model]) => <option key={id} value={id}>{model.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-1">
        <button className={button} onClick={() => run(() => frameModels(selected))}>{t('repositionPanel.frameMovingButton')}</button>
        <button className={button} disabled={!reference} onClick={() => run(() => frameModels([reference]))}>{t('repositionPanel.frameReferenceButton')}</button>
        <button className={button} disabled={!reference} onClick={() => run(() => frameModels([...selected, reference]))}>{t('repositionPanel.frameBothButton')}</button>
        <button className={button} disabled={!reference} onClick={nearReference}>{t('repositionPanel.moveNearReferenceButton')}</button>
      </div>
      <p className="text-zinc-500">{t('repositionPanel.moveNearNote')}</p>
      <div className="flex gap-1">
        <button className={button} onClick={() => run(() => { ensurePreview(); setRole('source'); })}>{t('repositionPanel.pickSourceButton')}</button>
        <button className={button} disabled={!preview?.source} onClick={() => setRole('target')}>{t('repositionPanel.pickTargetButton')}</button>
        <label><input type="checkbox" checked={snapEnabled} onChange={() => useViewerStore.getState().toggleSnap()} /> {t('repositionPanel.snapLabel')}</label>
      </div>
      <p role="status">{role ? t('repositionPanel.pickPrompt', { role: t(PICK_ROLE_KEYS[role]) }) : t('repositionPanel.previewPrompt')}
        {hover ? ` ${t('repositionPanel.hoverDetail', { kind: t(HOVER_KIND_KEYS[hover.kind]), name: models.get(hover.modelId)?.name ?? '' })}` : ''}</p>
      <label className="block">{t('repositionPanel.constraintLabel')}<select aria-label={t('repositionPanel.movementConstraintAriaLabel')} className="border bg-transparent p-1 ml-2"
        value={preview?.constraint ?? 'free'} onChange={(e) => run(() => { ensurePreview(); useViewerStore.getState().setMoveConstraint(e.target.value as MoveConstraint); })}>
        {['free', 'x', 'y', 'z', 'xy', 'xz', 'yz'].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
      <label className="block">{t('repositionPanel.inputLabel')}<select aria-label={t('repositionPanel.coordinateInputModeAriaLabel')} className="border bg-transparent p-1 ml-2" value={mode} onChange={(e) => setMode(e.target.value as 'delta' | 'absolute')}>
        <option value="delta">{t('repositionPanel.deltaModeOption')}</option><option value="absolute">{t('repositionPanel.absoluteModeOption')}</option></select></label>
      <div className="grid grid-cols-3 gap-1">{AXES.map((axis, i) => <label key={axis}>{mode === 'delta' ? t('repositionPanel.deltaPrefix') : ''}{axis}
        <input aria-label={t(mode === 'delta' ? 'repositionPanel.axisFieldDeltaAriaLabel' : 'repositionPanel.axisFieldSourceAriaLabel', { axis })} className="border w-full bg-transparent p-1 font-mono"
          value={fields[i]} onChange={(e) => setFields((previous) => previous.map((v, j) => i === j ? e.target.value : v))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); previewFields(); } }} /></label>)}</div>
      <button className={button} onClick={previewFields}>{t('repositionPanel.previewValuesButton')}</button>
      <label className="block">{t('repositionPanel.distanceLabel')}<input aria-label={t('repositionPanel.moveDistanceAriaLabel')} className="border w-24 bg-transparent p-1 ml-2" value={distance}
        onChange={(e) => setDistance(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); previewDistance(); } }} /></label>
      <button className={button} onClick={previewDistance}>{t('repositionPanel.previewDistanceButton')}</button>
      <output aria-label={t('repositionPanel.moveDimensionsAriaLabel')} className="block font-mono">{t('repositionPanel.moveOutput', {
        distance: Math.hypot(...delta).toFixed(4), dx: delta[0].toFixed(4), dy: delta[1].toFixed(4), dz: delta[2].toFixed(4),
      })}</output>
      <label className="block">{t('repositionPanel.nudgeIncrementLabel')}<input aria-label={t('repositionPanel.nudgeIncrementLabel')} className="border w-24 bg-transparent p-1 ml-2" value={nudgeField}
        onChange={(e) => setNudgeField(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); run(() => useViewerStore.getState().setRepositionNudge(parseMoveLength(nudgeField))); } }} onBlur={() => run(() => useViewerStore.getState().setRepositionNudge(parseMoveLength(nudgeField)))} /></label>
      <p>{t('repositionPanel.keyboardHelp')}</p>
      {selected.map((id) => <p key={id} className="font-mono truncate">{t('repositionPanel.modelPositionRow', {
        name: models.get(id)?.name ?? '', values: displayedTranslation(placement, id).map((v) => v.toFixed(4)).join(', '),
      })}</p>)}
      <RotationControls selected={selected} onError={setError} />
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-1">
        <button className={`${button} bg-teal-600 text-white`} disabled={!preview} onClick={apply}>{t('repositionPanel.applyButton')}</button>
        <button className={button} disabled={!placement.undo.length} onClick={() => run(() => useViewerStore.getState().undoModelTranslation())}>{t('repositionPanel.undoButton')}</button>
        <button className={button} disabled={!placement.redo.length} onClick={() => run(() => useViewerStore.getState().redoModelTranslation())}>{t('repositionPanel.redoButton')}</button>
        <button className={button} onClick={() => run(() => useViewerStore.getState().resetModelTranslations(selected))}>{t('repositionPanel.resetButton')}</button>
      </div>
      <PlacementFiles />
    </section>
  </>;
}
