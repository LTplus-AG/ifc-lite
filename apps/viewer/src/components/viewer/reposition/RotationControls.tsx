/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { parseRotationDegrees, radiansToDegrees, isZeroRotation, type ModelRotation } from '@/lib/model-placement/rotation';
import { addTranslation, finiteTranslation, type Translation } from '@/lib/model-placement/translation';
import { modelCenter } from '@/lib/model-placement/scene';
import { rotationRefusal } from '@/lib/model-placement/rotation-refusal';

const button = 'border px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40';
const AXES = ['X', 'Y'] as const;

/** A stored pivot is in the model's un-translated frame; the panel shows and
 * accepts WORKSPACE points, which is where it sits once the model is placed. */
function workspacePivot(rotation: ModelRotation, translation: Translation): Translation {
  return addTranslation(rotation.pivot, translation);
}

/** The workspace point the rotation turns about — the placed model's bounds
 * centre until the model has a heading. */
function defaultPivot(modelId: string): Translation {
  const state = useViewerStore.getState().modelPlacement;
  const placement = placementFor(state, modelId);
  // Once a model has a heading, keep the pivot it was given: re-deriving the
  // bounds centre of an already-turned model walks the axis a little further
  // on every edit, because a rotated model has a different bounding box.
  // Against the DISPLAYED translation, so an unapplied move preview — which
  // `rotatePlacements` commits along with the heading — carries the shown axis
  // with the model, exactly as `modelCenter` already does for the other branch.
  if (!isZeroRotation(placement.rotation)) return workspacePivot(placement.rotation, displayedTranslation(state, modelId));
  return modelCenter(modelId) ?? [0, 0, 0];
}

/** Rotation is entered as a value, not dragged, so it has no preview stage:
 * baking a heading costs a pass over the model's vertices. */
export function RotationControls({ selected, onError }: { selected: readonly string[]; onError: (message: string) => void }) {
  const { t } = useTranslation();
  const placement = useViewerStore((s) => s.modelPlacement);
  const models = useViewerStore((s) => s.models);
  const primary = selected[0];
  const current = primary ? placementFor(placement, primary).rotation : null;
  const translation = primary ? placementFor(placement, primary).translation : null;
  // The pending move too: the shown pivot has to follow the previewed
  // position, not only a committed one.
  const previewDelta = primary && placement.preview?.before.has(primary) ? placement.preview.delta : null;
  const [degrees, setDegrees] = useState('0');
  const [pivot, setPivot] = useState<[string, string]>(['0', '0']);

  useEffect(() => {
    if (!primary) return;
    const rotation = placementFor(useViewerStore.getState().modelPlacement, primary).rotation;
    setDegrees(String(Number(radiansToDegrees(rotation.angle).toFixed(6))));
    const point = defaultPivot(primary);
    setPivot([String(Number(point[0].toFixed(4))), String(Number(point[1].toFixed(4)))]);
    // The translation too: the stored pivot moves with the model, so the
    // workspace point shown has to follow a move made after rotating.
  }, [primary, current?.angle, current?.pivot, translation, previewDelta]);

  const applyRotation = useCallback((text: string, fields: readonly [string, string]) => {
    try {
      const angle = parseRotationDegrees(text);
      // Number('') is 0: a cleared field would silently turn the model about the origin.
      if (fields.some((field) => field.trim() === '')) throw new Error('Enter a finite pivot X and Y in metres.');
      const point: Translation = [Number(fields[0].replace(',', '.')), Number(fields[1].replace(',', '.')), 0];
      if (!finiteTranslation(point)) throw new Error('Enter a finite pivot X and Y in metres.');
      useViewerStore.getState().setModelRotation(selected, { angle, pivot: point });
      onError('');
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }, [selected, onError]);

  if (selected.length === 0) return null;
  // A pointcloud is a renderer handle a rotation bake never touches. Say so
  // instead of offering a control that can only fail.
  const refusal = rotationRefusal({ models }, selected);
  if (refusal) {
    return <fieldset className="space-y-1 border-t pt-2"><legend className="font-medium">{t('repositionPanel.rotation.legend')}</legend>
      <p className="text-zinc-500">{refusal}</p></fieldset>;
  }
  return <fieldset className="space-y-1 border-t pt-2">
    <legend className="font-medium">{t('repositionPanel.rotation.legend')}</legend>
    <p className="text-zinc-500">{t('repositionPanel.rotation.description')}</p>
    <label className="block">{t('repositionPanel.rotation.headingLabel')}
      <input aria-label={t('repositionPanel.rotation.angleAriaLabel')} className="border w-24 bg-transparent p-1 ml-2 font-mono"
        value={degrees} onChange={(event) => setDegrees(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyRotation(degrees, pivot); } }} /> °
    </label>
    <div className="grid grid-cols-2 gap-1">{AXES.map((axis, index) => <label key={axis}>{t('repositionPanel.rotation.pivotAxisLabel', { axis })}
      <input aria-label={t('repositionPanel.rotation.pivotAxisAriaLabel', { axis })} className="border w-full bg-transparent p-1 font-mono"
        value={pivot[index]} onChange={(event) => setPivot((previous) =>
          (index === 0 ? [event.target.value, previous[1]] : [previous[0], event.target.value]))}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyRotation(degrees, pivot); } }} /></label>)}
    </div>
    <p className="text-zinc-500">{t('repositionPanel.rotation.pivotNote')}</p>
    <div className="flex flex-wrap gap-1">
      <button className={button} onClick={() => applyRotation(degrees, pivot)}>{t('repositionPanel.rotation.applyButton')}</button>
      <button className={button} onClick={() => applyRotation('0', pivot)}>{t('repositionPanel.rotation.clearButton')}</button>
    </div>
    {selected.map((id) => <p key={id} className="font-mono truncate">{t('repositionPanel.rotation.summaryRow', {
      name: models.get(id)?.name ?? '',
      degrees: radiansToDegrees(placementFor(placement, id).rotation.angle).toFixed(3),
      pivot: workspacePivot(placementFor(placement, id).rotation, displayedTranslation(placement, id)).slice(0, 2)
        .map((value) => value.toFixed(3)).join(', '),
    })}</p>)}
  </fieldset>;
}
