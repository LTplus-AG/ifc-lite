/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { parseRotationDegrees, radiansToDegrees, isZeroRotation } from '@/lib/model-placement/rotation';
import { finiteTranslation, subtractTranslation, type Translation } from '@/lib/model-placement/translation';
import { modelCenter } from '@/lib/model-placement/scene';

const button = 'border px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40';
const AXES = ['X', 'Y'] as const;

/**
 * The pivot the rotation turns about, in the model's UN-translated workspace
 * frame — the rotation is baked into the geometry and the placement offset is
 * applied on top of it, so a pivot read off the moved model would be in the
 * wrong frame by exactly that offset.
 */
function defaultPivot(modelId: string): Translation {
  const state = useViewerStore.getState();
  const existing = placementFor(state.modelPlacement, modelId).rotation;
  // Once a model has a heading, keep the pivot it was given: re-deriving the
  // bounds centre of an already-turned model walks the axis a little further
  // on every edit, because a rotated model has a different bounding box.
  if (!isZeroRotation(existing)) return existing.pivot;
  const centre = modelCenter(modelId);
  if (!centre) return [0, 0, 0];
  return subtractTranslation(centre, placementFor(state.modelPlacement, modelId).translation);
}

/** Rotation is entered as a value, not dragged, so it has no preview stage:
 * baking a heading costs a pass over the model's vertices. */
export function RotationControls({ selected, onError }: { selected: readonly string[]; onError: (message: string) => void }) {
  const placement = useViewerStore((s) => s.modelPlacement);
  const models = useViewerStore((s) => s.models);
  const primary = selected[0];
  const current = primary ? placementFor(placement, primary).rotation : null;
  const [degrees, setDegrees] = useState('0');
  const [pivot, setPivot] = useState<[string, string]>(['0', '0']);

  useEffect(() => {
    if (!primary) return;
    const rotation = placementFor(useViewerStore.getState().modelPlacement, primary).rotation;
    setDegrees(String(Number(radiansToDegrees(rotation.angle).toFixed(6))));
    const point = defaultPivot(primary);
    setPivot([String(Number(point[0].toFixed(4))), String(Number(point[1].toFixed(4)))]);
  }, [primary, current?.angle, current?.pivot]);

  const applyRotation = useCallback((text: string, fields: readonly [string, string]) => {
    try {
      const angle = parseRotationDegrees(text);
      const point: Translation = [Number(fields[0].replace(',', '.')), Number(fields[1].replace(',', '.')), 0];
      if (!finiteTranslation(point)) throw new Error('Enter a finite pivot X and Y in metres.');
      useViewerStore.getState().setModelRotation(selected, { angle, pivot: point });
      onError('');
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }, [selected, onError]);

  if (selected.length === 0) return null;
  // A pointcloud carries only a translation, so rotating a mixed selection
  // would turn the models and leave the cloud behind. Say so instead of
  // offering a control that can only fail.
  if (selected.some((id) => models.get(id)?.pointCloudHandleId !== undefined)) {
    return <fieldset className="space-y-1 border-t pt-2"><legend className="font-medium">Rotate</legend>
      <p className="text-zinc-500">Pointclouds cannot be rotated. Select only IFC models to rotate.</p></fieldset>;
  }
  return <fieldset className="space-y-1 border-t pt-2">
    <legend className="font-medium">Rotate</legend>
    <p className="text-zinc-500">About the vertical axis only, counter-clockwise seen from above.
      Applied to the model before the placement offset above.</p>
    <label className="block">Heading
      <input aria-label="Rotation angle in degrees" className="border w-24 bg-transparent p-1 ml-2 font-mono"
        value={degrees} onChange={(event) => setDegrees(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyRotation(degrees, pivot); } }} /> °
    </label>
    <div className="grid grid-cols-2 gap-1">{AXES.map((axis, index) => <label key={axis}>Pivot {axis}
      <input aria-label={`Rotation pivot ${axis}`} className="border w-full bg-transparent p-1 font-mono"
        value={pivot[index]} onChange={(event) => setPivot((previous) =>
          (index === 0 ? [event.target.value, previous[1]] : [previous[0], event.target.value]))}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyRotation(degrees, pivot); } }} /></label>)}
    </div>
    <p className="text-zinc-500">Pivot is a workspace point in metres; elevation does not affect a vertical-axis turn.
      It defaults to the model&apos;s bounds centre.</p>
    <div className="flex flex-wrap gap-1">
      <button className={button} onClick={() => applyRotation(degrees, pivot)}>Apply rotation</button>
      <button className={button} onClick={() => applyRotation('0', pivot)}>Clear rotation</button>
    </div>
    {selected.map((id) => <p key={id} className="font-mono truncate">{models.get(id)?.name}:
      {' '}{radiansToDegrees(placementFor(placement, id).rotation.angle).toFixed(3)}° about
      {' '}{placementFor(placement, id).rotation.pivot.slice(0, 2).map((value) => value.toFixed(3)).join(', ')}</p>)}
  </fieldset>;
}
