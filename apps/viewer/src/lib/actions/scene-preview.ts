/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preflight for a scene action set: resolve every target and convert and check
 * every coordinate against the live store. A pure snapshot — nothing in the
 * scene changes. Apply re-runs it so a preview that went stale cannot be
 * applied as shown.
 *
 * An action is `ready` when it can do what it says on at least one resolved
 * element (or, for section/camera, when its coordinates are plausible);
 * otherwise it is `refused` with a reason. Unresolved targets inside a ready
 * action are counted, never silently widened or guessed.
 */

import type { ViewerState } from '@/store';
import type { EvidenceSnapshot } from '@/lib/assistant/evidence';
import { SCENE_PALETTE, type SceneAction, type SceneActionSet, type SceneColour, type SceneTarget } from './scene-actions';
import { citationContext, resolveSceneTarget, type CitationContext, type TargetStatus } from './scene-targets';
import {
  boxesOverlap, cameraReach, insideBounds, sceneFrame, toRenderBox, toRenderDirection, toRenderPoint,
  type RenderBounds, type RenderPoint,
} from './scene-coordinates';

export type RefusalReason = 'no-targets' | 'no-bounds' | 'outside-bounds';

export type TargetCounts = Record<TargetStatus, number>;

export interface ColourGroupPreview { label: string; colour: SceneColour; rgba: readonly [number, number, number, number]; ids: number[] }

export interface ActionPreview {
  index: number;
  action: SceneAction;
  status: 'ready' | 'refused';
  reason?: RefusalReason;
  /** Resolved renderer ids for target actions (union of groups for colour). */
  ids: number[];
  counts: TargetCounts;
  /** Colour: per-group resolved ids; an element named by several groups keeps the first. */
  groups?: ColourGroupPreview[];
  /** Colour: elements named by more than one group. */
  overlapping?: number;
  /** Isolate: resolved elements the user has hidden; they stay hidden. */
  hiddenTargets?: number;
  plane?: { normal: RenderPoint; point: RenderPoint };
  box?: RenderBounds;
  camera?: { eye: RenderPoint; target: RenderPoint };
}

export interface SceneActionPreview {
  set: SceneActionSet;
  actions: ActionPreview[];
  ready: number;
  refused: number;
}

type PreviewState = Pick<ViewerState, 'models' | 'mutationViews' | 'geometryResult' | 'hiddenEntities'>;

const emptyCounts = (): TargetCounts =>
  ({ resolved: 0, missing: 0, ambiguous: 0, 'stale-citation': 0, 'unknown-citation': 0, 'no-identity': 0 });

function resolveAll(state: PreviewState, targets: readonly SceneTarget[], evidence: CitationContext, counts: TargetCounts): number[] {
  const ids = new Set<number>();
  for (const target of targets) {
    const resolved = resolveSceneTarget(state, target, evidence);
    counts[resolved.status]++;
    for (const id of resolved.ids) ids.add(id);
  }
  return [...ids];
}

function previewAction(state: PreviewState, action: SceneAction, index: number, evidence: CitationContext): ActionPreview {
  const counts = emptyCounts();
  const refuse = (reason: RefusalReason, extra: Partial<ActionPreview> = {}): ActionPreview =>
    ({ index, action, status: 'refused', reason, ids: [], counts, ...extra });
  switch (action.type) {
    case 'select': case 'isolate': case 'hide': case 'frame': {
      const ids = resolveAll(state, action.targets, evidence, counts);
      if (ids.length === 0) return refuse('no-targets');
      const preview: ActionPreview = { index, action, status: 'ready', ids, counts };
      if (action.type === 'isolate') preview.hiddenTargets = ids.filter(id => state.hiddenEntities.has(id)).length;
      return preview;
    }
    case 'colour': {
      const claimed = new Set<number>();
      // Distinct elements named by more than one group (an element in three groups is one overlap).
      const overlaps = new Set<number>();
      const groups = action.groups.map((group): ColourGroupPreview => {
        const ids = resolveAll(state, group.targets, evidence, counts).filter(id => {
          if (!claimed.has(id)) { claimed.add(id); return true; }
          overlaps.add(id);
          return false;
        });
        return { label: group.label, colour: group.colour, rgba: SCENE_PALETTE[group.colour], ids };
      });
      const overlapping = overlaps.size;
      if (claimed.size === 0) return refuse('no-targets', { groups, overlapping });
      return { index, action, status: 'ready', ids: [...claimed], counts, groups, overlapping };
    }
    case 'section': {
      const frame = sceneFrame(state);
      if (!frame) return refuse('no-bounds');
      if ('plane' in action) {
        const point = toRenderPoint(action.plane.origin, action.units, frame);
        if (!insideBounds(point, frame.bounds, frame.tolerance)) return refuse('outside-bounds');
        return { index, action, status: 'ready', ids: [], counts, plane: { normal: toRenderDirection(action.plane.normal), point } };
      }
      const box = toRenderBox(action.box.min, action.box.max, action.units, frame);
      if (!boxesOverlap(box, frame.bounds, frame.tolerance)) return refuse('outside-bounds');
      return { index, action, status: 'ready', ids: [], counts, box };
    }
    case 'camera': {
      const frame = sceneFrame(state);
      if (!frame) return refuse('no-bounds');
      const eye = toRenderPoint(action.eye, action.units, frame);
      const target = toRenderPoint(action.target, action.units, frame);
      if (!insideBounds(target, frame.bounds, frame.tolerance) || !insideBounds(eye, frame.bounds, cameraReach(frame))) {
        return refuse('outside-bounds');
      }
      return { index, action, status: 'ready', ids: [], counts, camera: { eye, target } };
    }
  }
}

/** Resolve and check a whole set against `state`. */
export function previewSceneActions(state: PreviewState, set: SceneActionSet, evidence: EvidenceSnapshot | null): SceneActionPreview {
  const citations = citationContext(evidence);
  const actions = set.actions.map((action, index) => previewAction(state, action, index, citations));
  const ready = actions.filter(action => action.status === 'ready').length;
  return { set, actions, ready, refused: actions.length - ready };
}

/** Unresolved targets of one action, for the summary line. */
export function unresolvedCount(counts: TargetCounts): number {
  return counts.missing + counts.ambiguous + counts['stale-citation'] + counts['unknown-citation'] + counts['no-identity'];
}
