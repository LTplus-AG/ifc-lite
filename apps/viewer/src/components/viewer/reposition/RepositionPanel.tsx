/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { displayedTranslation, placementFor } from '@/lib/model-placement/state';
import { addTranslation, subtractTranslation, parseMoveLength, toRenderTranslation, translationAtDistance,
  type Translation, type MoveConstraint } from '@/lib/model-placement/translation';
import { frameModels, modelCenter } from '@/lib/model-placement/scene';
import { useRepositionPicking, type PickRole } from './useRepositionPicking';

import { PlacementFiles } from './PlacementFiles';
import { PlacementGizmo } from './PlacementGizmo';

const AXES = ['X', 'Y', 'Z'] as const;
const button = 'border px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40';

export function RepositionPanel() {
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
      if (target instanceof HTMLElement && (target.closest('input, textarea, select, button, summary, a[href], [role=button]') || target.isContentEditable)) return;
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
    <section aria-label="Reposition models" className="absolute top-32 right-4 z-40 w-80 max-h-[calc(100%-9rem)] overflow-auto border bg-white dark:bg-zinc-950 shadow-lg p-3 space-y-3 text-xs"
      onPointerDown={(event) => event.stopPropagation()}>
      <div className="sticky top-0 z-10 bg-white dark:bg-zinc-950 flex justify-between items-center"><strong>Reposition models</strong>
        <button className={button} aria-label="Cancel repositioning" onClick={() => useViewerStore.getState().closeReposition()}>Cancel</button></div>
      <p>Local workspace placement · metres · Z is elevation</p>
      <fieldset className="space-y-1"><legend className="font-medium">Moving models</legend>
        {[...models].map(([id, model]) => <div className="flex gap-2 items-center" key={id}>
          <label className="flex-1 truncate"><input type="checkbox" checked={selected.includes(id)}
            onChange={(event) => chooseModels(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} /> {model.name}</label>
          <button className={button} aria-label={`${placementFor(placement, id).locked ? 'Unlock' : 'Lock'} ${model.name}`}
            onClick={() => useViewerStore.getState().setModelPositionLocked(id, !placementFor(placement, id).locked)}>
            {placementFor(placement, id).locked ? 'Locked' : 'Unlocked'}</button>
        </div>)}
      </fieldset>
      <label className="block">Reference model<select aria-label="Reference model" className="border w-full bg-transparent p-1" value={reference} onChange={(e) => setReference(e.target.value)}>
        <option value="">Choose reference</option>{[...models].filter(([id]) => !selected.includes(id)).map(([id, model]) => <option key={id} value={id}>{model.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-1">
        <button className={button} onClick={() => run(() => frameModels(selected))}>Frame moving</button>
        <button className={button} disabled={!reference} onClick={() => run(() => frameModels([reference]))}>Frame reference</button>
        <button className={button} disabled={!reference} onClick={() => run(() => frameModels([...selected, reference]))}>Frame both</button>
        <button className={button} disabled={!reference} onClick={nearReference}>Move near reference</button>
      </div>
      <p className="text-zinc-500">Move near uses bounds centres for approximate positioning.</p>
      <div className="flex gap-1">
        <button className={button} onClick={() => run(() => { ensurePreview(); setRole('source'); })}>Pick source point</button>
        <button className={button} disabled={!preview?.source} onClick={() => setRole('target')}>Pick target point</button>
        <label><input type="checkbox" checked={snapEnabled} onChange={() => useViewerStore.getState().toggleSnap()} /> Snap</label>
      </div>
      <p role="status">{role ? `Pick a ${role} point. Use the other mouse buttons to navigate.` : 'Preview the move, then Apply.'}
        {hover ? ` ${hover.kind} · ${models.get(hover.modelId)?.name}` : ''}</p>
      <label className="block">Constraint<select aria-label="Movement constraint" className="border bg-transparent p-1 ml-2"
        value={preview?.constraint ?? 'free'} onChange={(e) => run(() => { ensurePreview(); useViewerStore.getState().setMoveConstraint(e.target.value as MoveConstraint); })}>
        {['free', 'x', 'y', 'z', 'xy', 'xz', 'yz'].map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
      <label className="block">Input<select aria-label="Coordinate input mode" className="border bg-transparent p-1 ml-2" value={mode} onChange={(e) => setMode(e.target.value as 'delta' | 'absolute')}>
        <option value="delta">Move by ΔX / ΔY / ΔZ</option><option value="absolute">Set source point X / Y / Z</option></select></label>
      <div className="grid grid-cols-3 gap-1">{AXES.map((axis, i) => <label key={axis}>{mode === 'delta' ? 'Δ' : ''}{axis}
        <input aria-label={`${mode === 'delta' ? 'Delta ' : 'Source '}${axis}`} className="border w-full bg-transparent p-1 font-mono"
          value={fields[i]} onChange={(e) => setFields((previous) => previous.map((v, j) => i === j ? e.target.value : v))}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); previewFields(); } }} /></label>)}</div>
      <button className={button} onClick={previewFields}>Preview values</button>
      <label className="block">Distance along direction<input aria-label="Move distance" className="border w-24 bg-transparent p-1 ml-2" value={distance}
        onChange={(e) => setDistance(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); previewDistance(); } }} /></label>
      <button className={button} onClick={previewDistance}>Preview distance</button>
      <output aria-label="Move dimensions" className="block font-mono">Move {Math.hypot(...delta).toFixed(4)} m · ΔX {delta[0].toFixed(4)} · ΔY {delta[1].toFixed(4)} · ΔZ {delta[2].toFixed(4)}</output>
      <label className="block">Nudge increment<input aria-label="Nudge increment" className="border w-24 bg-transparent p-1 ml-2" value={nudgeField}
        onChange={(e) => setNudgeField(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); run(() => useViewerStore.getState().setRepositionNudge(parseMoveLength(nudgeField))); } }} onBlur={() => run(() => useViewerStore.getState().setRepositionNudge(parseMoveLength(nudgeField)))} /></label>
      <p>Hold Shift while picking for orthogonal movement. Choose X/Y/Z, then ↑/↓ to nudge. Enter applies. Escape cancels.</p>
      {selected.map((id) => <p key={id} className="font-mono truncate">{models.get(id)?.name}: {displayedTranslation(placement, id).map((v) => v.toFixed(4)).join(', ')} m</p>)}
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-1">
        <button className={`${button} bg-teal-600 text-white`} disabled={!preview} onClick={apply}>Apply</button>
        <button className={button} disabled={!placement.undo.length} onClick={() => run(() => useViewerStore.getState().undoModelTranslation())}>Undo move</button>
        <button className={button} disabled={!placement.redo.length} onClick={() => run(() => useViewerStore.getState().redoModelTranslation())}>Redo move</button>
        <button className={button} onClick={() => run(() => useViewerStore.getState().resetModelTranslations(selected))}>Reset placement</button>
      </div>
      <PlacementFiles />
    </section>
  </>;
}
