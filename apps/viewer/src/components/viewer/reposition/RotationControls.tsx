/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { placementFor } from '@/lib/model-placement/state';
import { parseRotationDegrees, radiansToDegrees, isZeroRotation, type ModelRotation } from '@/lib/model-placement/rotation';
import { addTranslation, finiteTranslation, type Translation } from '@/lib/model-placement/translation';
import { modelCenter } from '@/lib/model-placement/scene';

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
  const placement = placementFor(useViewerStore.getState().modelPlacement, modelId);
  // Once a model has a heading, keep the pivot it was given: re-deriving the
  // bounds centre of an already-turned model walks the axis a little further
  // on every edit, because a rotated model has a different bounding box.
  if (!isZeroRotation(placement.rotation)) return workspacePivot(placement.rotation, placement.translation);
  return modelCenter(modelId) ?? [0, 0, 0];
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
    <p className="text-zinc-500">Pivot is one workspace point in metres for every selected model; elevation does not
      affect a vertical-axis turn. It defaults to the model&apos;s bounds centre and moves with the model afterwards.</p>
    <div className="flex flex-wrap gap-1">
      <button className={button} onClick={() => applyRotation(degrees, pivot)}>Apply rotation</button>
      <button className={button} onClick={() => applyRotation('0', pivot)}>Clear rotation</button>
    </div>
    {selected.map((id) => <p key={id} className="font-mono truncate">{models.get(id)?.name}:
      {' '}{radiansToDegrees(placementFor(placement, id).rotation.angle).toFixed(3)}° about
      {' '}{workspacePivot(placementFor(placement, id).rotation, placementFor(placement, id).translation).slice(0, 2)
        .map((value) => value.toFixed(3)).join(', ')}</p>)}
  </fieldset>;
}
