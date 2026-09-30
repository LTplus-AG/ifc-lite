/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mesh snap source: an adapter over the renderer's `raycastSceneMagnetic`
 * result (its `SnapDetector` becomes one candidate source among several).
 *
 * The magnetic "stick and slide along edges" behaviour lives in the renderer
 * and needs the held edge lock fed back every move. This source owns that
 * round-trip: it passes the current lock in, then applies the result's
 * lock / release exactly as `pickMeasurePoint` does, so a command using the
 * engine keeps the same feel as measure and the Model workspace commands.
 *
 * The raycast itself is injected (`pick`), bound by the caller to the current
 * pointer, so this module stays free of the DOM and the GPU.
 */

import type { EdgeLockInput, MagneticSnapResult } from '@ifc-lite/renderer';
import type { SnapCandidate, SnapKind, SnapQuery, SnapSource, Vec2 } from '../types.js';

type RVec3 = { x: number; y: number; z: number };

export type MeshPick = MagneticSnapResult & { intersection: { point: RVec3; expressId: number } | null };

/** Read/write access to the viewer's edge-lock state (`edgeLockStateRef` + `setEdgeLock`/`clearEdgeLock`). */
export interface EdgeLockPort {
  get(): EdgeLockInput;
  set(edge: { v0: RVec3; v1: RVec3 }, meshExpressId: number, edgeT: number): void;
  clear(): void;
}

export interface MeshSourceDeps {
  /** The renderer's magnetic raycast at the current pointer, given the held edge lock. */
  pick(lock: EdgeLockInput): MeshPick | null;
  lock: EdgeLockPort;
  /** Render space → workplane-local 2D plus height above the workplane; null when unmappable. */
  toLocal(p: RVec3): { local: Vec2; elevation: number } | null;
  /** Resolve a renderer (global) id to its model entity. */
  entityOf?(globalId: number): { modelId: string; expressId: number } | null;
}

export interface MeshSource extends SnapSource {
  /** The raw pick of the last collect (for callers that derive the cursor from the hit). */
  lastPick(): MeshPick | null;
}

/** Renderer `SnapType` values → engine kinds. A face centre is a face target. */
const KIND: Readonly<Record<string, SnapKind>> = {
  vertex: 'vertex',
  edge: 'edge',
  face: 'face',
  face_center: 'face',
  point_cloud: 'vertex',
};

const PLAN_EPS = 1e-9;

export function createMeshSource(deps: MeshSourceDeps, id = 'mesh'): MeshSource {
  let last: MeshPick | null = null;

  const entity = (globalId: number | undefined): SnapCandidate['entity'] => {
    if (globalId === undefined || !deps.entityOf) return undefined;
    return deps.entityOf(globalId) ?? undefined;
  };

  function syncLock(pick: MeshPick): void {
    const l = pick.edgeLock;
    if (l.shouldRelease) deps.lock.clear();
    else if (l.shouldLock && l.edge && l.meshExpressId !== null) deps.lock.set(l.edge, l.meshExpressId, l.edgeT);
  }

  return {
    id,
    lastPick: () => last,
    collect(_q: SnapQuery, _radius: number, out: SnapCandidate[]): void {
      const pick = deps.pick(deps.lock.get());
      last = pick;
      if (!pick) return;
      syncLock(pick);

      const t = pick.snapTarget;
      const kind = t ? KIND[t.type] : undefined;
      const owner = entity(t?.expressId ?? pick.intersection?.expressId);
      if (t && kind) {
        const at = deps.toLocal(t.position);
        if (at) {
          const c: SnapCandidate = { kind, local: at.local, elevation: at.elevation, source: 'mesh', entity: owner };
          const edge = kind === 'edge' ? edgeOf(pick, t.metadata?.vertices) : null;
          const a = edge ? deps.toLocal(edge[0]) : null;
          const b = edge ? deps.toLocal(edge[1]) : null;
          const planar = a && b && Math.hypot(a.local[0] - b.local[0], a.local[1] - b.local[1]) > PLAN_EPS;
          if (a && b && planar) c.guide = { kind: 'segment', a: a.local, b: b.local, role: 'edge' };
          out.push(c);
          // The hovered edge's ends and midpoint are targets too (the detector reports only one).
          if (a) out.push({ kind: 'endpoint', local: a.local, elevation: a.elevation, source: 'mesh', entity: owner });
          if (a && b && planar) {
            out.push({ kind: 'endpoint', local: b.local, elevation: b.elevation, source: 'mesh', entity: owner });
            out.push({
              kind: 'midpoint', local: [(a.local[0] + b.local[0]) / 2, (a.local[1] + b.local[1]) / 2],
              elevation: (a.elevation + b.elevation) / 2, source: 'mesh', entity: owner,
            });
          }
        }
      }
      // The plain surface hit, so a face under the cursor still names its entity.
      if (pick.intersection && kind !== 'face') {
        const at = deps.toLocal(pick.intersection.point);
        if (at) out.push({ kind: 'face', local: at.local, elevation: at.elevation, source: 'mesh', entity: owner });
      }
    },
  };
}

/** The edge a target lies on: the lock's edge (magnetic), else the detector's edge vertices. */
function edgeOf(pick: MeshPick, vertices: readonly RVec3[] | undefined): readonly [RVec3, RVec3] | null {
  const e = pick.edgeLock.edge;
  if (e) return [e.v0, e.v1];
  if (vertices && vertices.length >= 2) return [vertices[0], vertices[1]];
  return null;
}
