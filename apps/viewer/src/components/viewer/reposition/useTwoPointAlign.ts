/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two-point align session (#11505): the mode flag, the four picked points,
 * and the apply/cancel commands. Owned by `RepositionRuntimeHost` next to the
 * pick role, published through the reposition runtime so the Local tab can show
 * it, and fed by `useRepositionPicking`'s `capture` hook so the existing pick
 * machinery (snapping, per-role model eligibility) is reused unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewerStore } from '@/store';
import type { PlacementAnchor } from '@/lib/model-placement/state';
import { ALIGN_REFUSAL_MESSAGES, nextAlignStep, recordAlignPick, roleForAlignStep, solveAlignPoints,
  type AlignPoints, type AlignStep } from '@/lib/model-placement/two-point-align-session';
import type { TwoPointAlignResult } from '@/lib/model-placement/two-point-align';
import type { PickRole } from './useRepositionPicking';

export interface TwoPointAlignSession {
  active: boolean;
  points: AlignPoints;
  /** The step awaiting a pick, null once all four are in. */
  step: AlignStep | null;
  /** Null until all four points are picked. */
  result: TwoPointAlignResult | null;
  /** True when a placement change cleared earlier picks. */
  cleared: boolean;
  start: () => void;
  cancel: () => void;
  repick: () => void;
  apply: () => void;
  /** Stable for the life of the host: the picking effect must not re-register
   * mid-gesture, or the click that finishes a pick would never be seen. */
  capture: (role: 'source' | 'target', anchor: PlacementAnchor) => PickRole;
}

interface Options {
  selected: readonly string[];
  reference: string;
  setRole: (role: PickRole) => void;
  setError: (message: string) => void;
}

export function useTwoPointAlign({ selected, reference, setRole, setError }: Options): TwoPointAlignSession {
  const [active, setActive] = useState(false);
  const [points, setPoints] = useState<AlignPoints>({});
  const [cleared, setCleared] = useState(false);
  const pointsRef = useRef<AlignPoints>({});
  const activeRef = useRef(false);
  const revisionRef = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const revision = useViewerStore((s) => s.modelPlacement.revision);

  const commitPoints = useCallback((next: AlignPoints) => {
    pointsRef.current = next;
    revisionRef.current = useViewerStore.getState().modelPlacement.revision;
    setPoints(next);
  }, []);
  const exit = useCallback(() => {
    activeRef.current = false;
    setActive(false); setCleared(false); setRole(null);
    commitPoints({});
  }, [commitPoints, setRole]);

  const start = useCallback(() => {
    if (selectedRef.current.length === 0 || !reference) return;
    // A pick needs a preview to exist (the picking hook gates on it); a pending
    // move preview is kept, and carried by the apply.
    if (!useViewerStore.getState().modelPlacement.preview) useViewerStore.getState().openReposition(selectedRef.current);
    activeRef.current = true;
    setActive(true); setCleared(false); setError('');
    commitPoints({});
    setRole('source');
  }, [commitPoints, reference, setError, setRole]);

  const repick = useCallback(() => { setCleared(false); commitPoints({}); setRole('source'); }, [commitPoints, setRole]);

  const capture = useCallback((role: 'source' | 'target', anchor: PlacementAnchor): PickRole => {
    const next = recordAlignPick(pointsRef.current, role, anchor.point);
    if (!next) return role;
    commitPoints(next);
    setCleared(false);
    return roleForAlignStep(nextAlignStep(next));
  }, [commitPoints]);

  const result = useMemo(() => solveAlignPoints(points), [points]);

  const apply = useCallback(() => {
    try {
      const solved = solveAlignPoints(pointsRef.current);
      if (!solved) throw new Error('Pick all four points first.');
      if (!solved.ok) throw new Error(ALIGN_REFUSAL_MESSAGES[solved.reason]);
      const ids = selectedRef.current;
      const store = useViewerStore.getState();
      store.alignModels(ids, solved.alignment);
      // Back to a fresh preview for the same models, as the move Apply does.
      store.openReposition(ids);
      setError('');
      exit();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }, [exit, setError]);

  // A placement change after a pick (gizmo drag, nudge, undo) moves the models
  // the points were read off, so they no longer describe the scene: start over.
  useEffect(() => {
    if (!activeRef.current || revision === revisionRef.current) return;
    if (nextAlignStep(pointsRef.current) === 'a') { revisionRef.current = revision; return; }
    commitPoints({}); setCleared(true); setRole('source');
  }, [revision, commitPoints, setRole]);

  // The moving set changed under the session.
  const selectionKey = selected.join('|');
  useEffect(() => { if (activeRef.current) exit(); }, [selectionKey, exit]);

  return { active, points, step: nextAlignStep(points), result, cleared, start, cancel: exit, repick, apply, capture };
}
