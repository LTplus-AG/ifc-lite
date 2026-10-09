/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewport preview of a reviewed authoring batch: ghost meshes for every
 * ready geometry-affecting row, drawn on the `proposal` authoring overlay
 * channel (never through `geometryResult`) until the review is applied,
 * dismissed or unmounted. New elements are prisms of the builder's own
 * footprint and height on the storey workplane (the same map the Model
 * workspace's tools ghost and commit through); moves and turns are the
 * element's current meshes transformed as the commit will; deletions are its
 * meshes in red. Joins, types and materials change no placement and have no
 * ghost; their row says what changes.
 */

import { alignmentGhosts } from '@/lib/commands/modeling/align-ghosts';
import { authoringSlabOpeningGhost } from './model-authoring-slab-opening-ghost';
import { stairRailingGhost } from './model-authoring-stair-railing-ghost';
import { linearProfileFrame } from '@ifc-lite/create';
import { sectionGhostMesh } from '@/lib/profile-section/profile-outline';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import { centredRectOutline, prismGhostMesh, rectOutline, segmentOutline } from '@/lib/commands/modeling/ghost-shapes';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import type { Workplane } from '@/lib/commands/modeling/types';
import { transformedGhosts, type TransformSelection } from '@/lib/commands/modeling/commands/element-transform-shared';
import { planElementTransform } from '@/lib/element-transform/plan';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { authoringCopyGhosts } from './model-authoring-copy-ghost';
import { authoredElementOf, type ElementId } from './model-authoring-native';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow, ModelAuthoringPreview } from './model-authoring-preview';
import { authoringReader } from './model-authoring-read';
import { authoringHostedEditGhost } from './model-authoring-hosted-edit-ghost';
import { authoringSplitMarker } from './model-authoring-split-ghost';
import { authoringSizeGhost } from './model-authoring-size-ghost';

const DELETE_COLOR: [number, number, number, number] = [0.95, 0.25, 0.2, 0.45];
/** Above the `command` channel's ids, so the two channels never remove each other's meshes. */
const GHOST_INDEX = 4096;

type V3 = readonly [number, number, number];
interface WallAxis { start: V3; end: V3; thickness: number }

function plane(state: ViewerState, modelId: string, storeyId: number | null): Workplane | null {
  if (storeyId === null) return null;
  const built = buildStoreyWorkplane(state, modelId, storeyId, 0);
  return isWorkplane(built) ? built : null;
}

function createGhost(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData | null {
  const op = row.op as Extract<AuthoringOp, { op: 'element.create' }>;
  const wp = plane(state, row.modelId!, row.resolved.storey ?? null);
  if (!wp) return null;
  const element = authoredElementOf(batch, op);
  if (element.kind === 'beam' || element.kind === 'member') {
    const p = element.params;
    const profile = 'Profile' in p ? p.Profile : { Type: 'Rectangle' as const, XDim: p.Width, YDim: p.Height };
    return sectionGhostMesh(wp, profile, linearProfileFrame(p.Start, p.End), id);
  }
  if (element.kind === 'column' && 'Profile' in element.params) {
    const p = element.params;
    return sectionGhostMesh(wp, p.Profile, { origin: p.Position, u: [1, 0, 0], v: [0, 1, 0], along: [0, 0, 1], length: p.Height }, id);
  }
  if ((element.kind === 'slab' || element.kind === 'roof' || element.kind === 'plate' || element.kind === 'space') && 'OuterCurve' in element.params) {
    const p = element.params, origin = p.Position ?? [0, 0, 0];
    const depth = 'Thickness' in p ? p.Thickness : p.Height;
    return prismGhostMesh(wp, p.OuterCurve.map(([x, y]) => [x + origin[0], y + origin[1]]), origin[2], origin[2] + depth, id);
  }
  switch (element.kind) {
    case 'wall': {
      const p = element.params;
      const outline = segmentOutline([p.Start[0], p.Start[1]], [p.End[0], p.End[1]], p.Thickness);
      return prismGhostMesh(wp, outline, p.Start[2], p.Start[2] + p.Height, id);
    }
    case 'column': {
      const p = element.params as { Position: V3; Width: number; Depth: number; Height: number };
      return prismGhostMesh(wp, centredRectOutline([p.Position[0], p.Position[1]], p.Width, p.Depth, 0), p.Position[2], p.Position[2] + p.Height, id);
    }
    default: {
      const p = element.params as { Position: V3; Width: number; Depth: number; Thickness?: number; Height?: number };
      const outline = rectOutline([p.Position[0], p.Position[1]], [p.Position[0] + p.Width, p.Position[1] + p.Depth]);
      return prismGhostMesh(wp, outline, p.Position[2], p.Position[2] + (p.Thickness ?? p.Height ?? 0), id);
    }
  }
}

/** The host wall's axis in its storey, metres: from the creating row, or read from the model. */
function hostAxis(state: ViewerState, batch: ModelAuthoringBatch, preview: ModelAuthoringPreview, row: AuthoringRow, host: ElementId): { axis: WallAxis; storey: number | null } | null {
  if ('ref' in host) {
    const creator = preview.rows[row.dependsOn[0]];
    if (creator.op.op !== 'element.create') return null;
    const element = authoredElementOf(batch, creator.op);
    if (element.kind !== 'wall') return null;
    return { axis: { start: element.params.Start, end: element.params.End, thickness: element.params.Thickness }, storey: creator.resolved.storey ?? null };
  }
  const reader = authoringReader(state, row.modelId!);
  const wall = reader ? readWallMetres(reader, host.id) : null;
  return wall ? { axis: { start: wall.start, end: wall.end, thickness: wall.thickness }, storey: elementStoreyId(state, row.modelId!, host.id) } : null;
}

function hostedGhost(state: ViewerState, batch: ModelAuthoringBatch, preview: ModelAuthoringPreview, row: AuthoringRow, id: number): MeshData | null {
  const op = row.op as Extract<AuthoringOp, { op: 'hosted.create' }>;
  if ('params' in op) return null; // Slab cutters never use the wall-only ghost.
  const host = hostAxis(state, batch, preview, row, row.resolved.host!);
  const wp = host ? plane(state, row.modelId!, host.storey) : null;
  if (!host || !wp) return null;
  const { start, end, thickness } = host.axis;
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (!(length > 0)) return null;
  const dir = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  const m = (v: number) => toMetres(batch, v);
  const at = (d: number): [number, number] => [start[0] + dir[0] * d, start[1] + dir[1] * d];
  const centre = m(op.offset), half = m(op.width) / 2;
  // The cut overshoots each face by 50 mm, as `addOpeningToStore` does.
  return prismGhostMesh(wp, segmentOutline(at(centre - half), at(centre + half), thickness + 0.1), start[2] + m(op.sill), start[2] + m(op.sill) + m(op.height), id);
}

function transformGhosts(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData[] {
  const reader = authoringReader(state, row.modelId!);
  const target = row.resolved.target!;
  if (!reader) return [];
  const plan = planElementTransform({ dataStore: reader.dataStore, view: reader.view, selected: [target], storeyOf: (e) => elementStoreyId(state, reader.modelId, e) });
  const root = plan.roots.find((r) => r.expressId === target);
  const wp = root ? plane(state, reader.modelId, root.storeyId) : null;
  if (!root || !wp) return [];
  const moved = [...plan.roots.map((r) => r.expressId), ...plan.carried];
  const selection: TransformSelection = { modelId: reader.modelId, ids: [target], refusal: null,
    movedGlobalIds: moved.map((e) => toGlobalIdFromModels(state.models, reader.modelId, e)) };
  const op = row.op;
  const origin = wp.localToRender([0, 0, 0]);
  if (op.op === 'element.move') {
    return transformedGhosts(state, selection, { kind: 'move', from: origin, to: wp.localToRender([toMetres(batch, op.delta[0]), toMetres(batch, op.delta[1]), 0]) }, wp.plane.normal, id);
  }
  if (op.op === 'element.rotate') {
    return transformedGhosts(state, selection, { kind: 'rotate', pivot: wp.localToRender(op.pivot ? [toMetres(batch, op.pivot[0]), toMetres(batch, op.pivot[1]), 0] : [root.origin[0], root.origin[1], 0]), angle: (op.angleDeg * Math.PI) / 180 }, wp.plane.normal, id);
  }
  return transformedGhosts(state, selection, { kind: 'move', from: origin, to: origin }, wp.plane.normal, id).map((mesh) => ({ ...mesh, color: DELETE_COLOR }));
}

/** Ghost meshes for the ready rows of `preview`, in render space. */
export function authoringGhosts(state: ViewerState, preview: ModelAuthoringPreview): MeshData[] {
  const meshes: MeshData[] = [];
  for (const row of preview.rows) {
    if (row.status !== 'ready' || !row.modelId) continue;
    const id = commandGhostId(state, GHOST_INDEX + row.index);
    if (row.op.op === 'element.resize' || row.op.op === 'element.profile' || row.op.op === 'element.trimExtend') {
      const ghost = authoringSizeGhost(state, preview.batch, row, row.modelId, id);
      if (ghost.mesh) meshes.push(ghost.mesh);
      continue;
    }
    if (row.op.op === 'hosted.edit') { const mesh = authoringHostedEditGhost(state, preview.batch, row, id, preview.rows); if (mesh) meshes.push(mesh); continue; }
    if (row.op.op === 'element.split') { const mesh = authoringSplitMarker(state, preview.batch, row, id); if (mesh) meshes.push(mesh); continue; }
    switch (row.op.op) {
      case 'stair.create': case 'railing.create': case 'stair.replace': case 'railing.replace': {const mesh=stairRailingGhost(state,preview.batch,row,id);row.previewUnavailable=!mesh;if(mesh)meshes.push(mesh);break;}
      case 'element.create': { const mesh = createGhost(state, preview.batch, row, id); if (mesh) meshes.push(mesh); break; }
      case 'hosted.create': { const mesh = 'params' in row.op ? authoringSlabOpeningGhost(state,row,preview.rows,id) : hostedGhost(state, preview.batch, preview, row, id); if (mesh) meshes.push(mesh); break; }
      case 'element.copy': case 'element.array': meshes.push(...authoringCopyGhosts(state, preview.batch, row, id)); break;
      case 'element.align': {
        const a = row.resolved.alignment;
        if (a?.geometry) {
          const target = authoringReader(state, row.modelId);
          const plan = target ? planElementTransform({ ...target, selected: a.targets, storeyOf: () => a.storeyId }) : null;
          meshes.push(...alignmentGhosts({ ...a, reference: a.reference, boxes: a.geometry.boxes, mode: row.op.mode, hover: null, carried: plan?.carried }, a.geometry.plane, id));
        }
        break;
      }
      case 'element.move': case 'element.rotate': case 'element.delete': meshes.push(...transformGhosts(state, preview.batch, row, id)); break;
      default: break;
    }
  }
  return meshes;
}
