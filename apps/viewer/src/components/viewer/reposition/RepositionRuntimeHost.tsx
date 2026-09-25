/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local-reposition session's scene overlay and keyboard shortcuts
 * (#5505: the docked `placement` panel's Local tab now carries the form that
 * used to live in this component's floating `RepositionPanel` card). Mounted
 * by `ToolOverlays` whenever a reposition is open and the select tool is
 * active — same gate as before. It owns every piece of session-local state
 * (which models moved, the reference model, the typed fields, the pick
 * role...) and publishes it through `reposition-runtime.ts` so the Local tab,
 * mounted separately in the sidebar/float/pop-out, can read and drive it.
 */
import { useCallback, useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { isTextEntryTarget } from '@/lib/keyboard-event';
import { addTranslation, subtractTranslation, parseMoveLength, toRenderTranslation, translationAtDistance,
  type Translation, type MoveConstraint } from '@/lib/model-placement/translation';
import { modelCenter } from '@/lib/model-placement/scene';
import { publishRepositionRuntime } from '@/lib/model-placement/reposition-runtime';
import { useRepositionPicking, type PickRole } from './useRepositionPicking';
import { PlacementGizmo } from './PlacementGizmo';

export function RepositionRuntimeHost() {
  // Surface the docked `placement` panel's Local tab (#5505) whenever a
  // reposition session starts, mirroring how the Section tool auto-opens the
  // Drawing panel (`DrawingRuntimeHost`, #5493). Runs once per mount — this
  // host only mounts while a session is open (see `ToolOverlays`) — so a
  // user who deliberately switches to another panel mid-session keeps it.
  useEffect(() => { useViewerStore.getState().openPanelInHome('placement', 'programmatic'); }, []);
  const models = useViewerStore((s) => s.models);
  const placement = useViewerStore((s) => s.modelPlacement);
  const project = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const [selected, setSelected] = useState<readonly string[]>(placement.preview?.modelIds ?? []);
  const [reference, setReference] = useState([...models.keys()].find((id) => !selected.includes(id)) ?? '');
  const [fields, setFields] = useState<[string, string, string]>(['0', '0', '0']);
  const [mode, setMode] = useState<'delta' | 'absolute'>('delta');
  const nudge = useViewerStore((s) => s.repositionNudge);
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
    setFields(value.map((component) => String(component)) as [string, string, string]);
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

  const chooseModels = useCallback((ids: readonly string[]) => run(() => {
    useViewerStore.getState().openReposition(ids); setSelected(ids); setRole(null);
    if (ids.includes(reference)) setReference([...models.keys()].find((id) => !ids.includes(id)) ?? '');
  }), [models, reference, run]);
  const previewFields = useCallback(() => run(() => {
    ensurePreview();
    const value: Translation = [parseMoveLength(fields[0]), parseMoveLength(fields[1]), parseMoveLength(fields[2])];
    let next = value;
    if (mode === 'absolute') {
      const source = useViewerStore.getState().modelPlacement.preview?.source;
      if (!source) throw new Error('Pick a source reference point before setting its coordinates.');
      next = subtractTranslation(value, source.point);
    }
    useViewerStore.getState().previewModelTranslation(next);
  }), [ensurePreview, fields, mode, run]);
  const previewDistance = useCallback(() => run(() => {
    ensurePreview();
    const current = useViewerStore.getState().modelPlacement.preview!;
    const axis = ['x', 'y', 'z'].indexOf(current.constraint);
    const direction: Translation = axis < 0 ? current.delta : [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
    useViewerStore.getState().previewModelTranslation(translationAtDistance(direction, parseMoveLength(distance)));
  }), [distance, ensurePreview, run]);
  const nearReference = useCallback(() => run(() => {
    ensurePreview();
    const source = modelCenter(selected[0]), target = modelCenter(reference);
    if (!source || !target) throw new Error('Both models need available bounds.');
    const prior = useViewerStore.getState().modelPlacement.preview!.delta;
    useViewerStore.getState().previewModelTranslation(addTranslation(prior, subtractTranslation(target, source)));
  }), [ensurePreview, reference, run, selected]);
  const applyNudge = useCallback(() => run(() => useViewerStore.getState().setRepositionNudge(parseMoveLength(nudgeField))), [nudgeField, run]);
  const setFieldAt = useCallback((index: number, value: string) => {
    setFields((previous) => previous.map((v, j) => (index === j ? value : v)) as [string, string, string]);
  }, []);

  useEffect(() => {
    publishRepositionRuntime({
      selected, reference, fields, mode, nudgeField, error, distance, role, hover,
      setError, setReference, setFieldAt, setMode, setNudgeField, setDistance, setRole,
      chooseModels, previewFields, previewDistance, nearReference, applyNudge, apply,
    });
  }, [selected, reference, fields, mode, nudgeField, error, distance, role, hover,
    chooseModels, previewFields, previewDistance, nearReference, applyNudge, apply, setFieldAt]);
  useEffect(() => () => publishRepositionRuntime(null), []);

  const projected = hover && project ? (() => {
    const [x, y, z] = toRenderTranslation(hover.point); return project({ x, y, z });
  })() : null;

  return <>
    <PlacementGizmo disabled={role !== null} onError={setError} />
    {projected && <div aria-hidden className="absolute pointer-events-none z-40 border-2 border-overlay-accent rounded-full w-3 h-3"
      style={{ left: projected.x - 6, top: projected.y - 6 }} />}
  </>;
}
