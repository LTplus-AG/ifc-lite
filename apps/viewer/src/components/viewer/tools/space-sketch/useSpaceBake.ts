/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The emit half of Space Sketch: turning every storey's draft plate into real
 * `IfcSpace`, once, on confirm.
 *
 * Split out of `SpaceSketchOverlay.tsx` because this is a self-contained
 * subject with its own state (`generatedRef`, the ids this tool authored per
 * storey) and its own failure stories, none of which involve the 2D editor:
 * re-confirming duplicating spaces instead of replacing them, one storey's
 * `addSpace` failure being reported as a "skip" and silently dropping rooms
 * from the export, and a partial failure closing the tool and discarding the
 * remaining drafts. The decisions live in `space-bake.ts`; this hook is the
 * store-facing plumbing around them.
 *
 * It also owns the ONE frame change in the tool. Everything upstream — the
 * plate, the 2D drawing, the 3D ghost, the areas — works in the room frame
 * `wall-rects-from-meshes.ts` defines, which is the model's own world frame
 * because the outlines are derived from rendered geometry. `addSpace` writes
 * into a storey-local slot, and `existingSpaceFootprintsByStorey` reads out of
 * one, so both directions cross the storey's placement chain here and nowhere
 * else. Skipping either crossing is not a small error: the chain carries the
 * site anchor, so a room lands a whole site offset away and turned by the site
 * rotation, and the dedup stops recognising the rooms already in the file.
 */

import { useCallback, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  existingSpaceFootprintsByStorey,
  fromStoreyLocal,
  storeyPlanFrame,
  toStoreyLocal,
  GENERATED_SPACE_OBJECTTYPE,
  type BoundaryMode,
  type StoreyPlanFrame,
} from '@ifc-lite/create';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { roomFrameToModelWorld } from '@/lib/wall-rects-from-meshes';
import type { SpacePlateSession } from '@/lib/space-plate-session';
import type { Pt } from '@/lib/space-sketch-geometry';
import { planStoreySpaces, type DraftRoom } from './space-bake';

export interface SpaceBakeResult {
  emitted: number;
  floors: number;
  error: string | null;
}

export interface UseSpaceBakeOptions {
  /** Model the spaces are authored into; null refuses to guess. */
  sketchModelId: string | null;
  ifcDataStore: IfcDataStore | null;
  /** Net / gross / centre outline the user picked. */
  boundaryMode: BoundaryMode;
  /** Every storey's draft plate, keyed by storey expressId. */
  sessionsRef: React.RefObject<Map<number, SpacePlateSession>>;
  floorToFloor: (sid: number) => number;
  /**
   * The loaded model's coordinate info, as `wallRectsFromMeshes` was given it.
   * Read only to place the room frame relative to the model's own world frame
   * — see `roomFrameToModelWorld`.
   */
  coordinateInfo: CoordinateInfo | undefined;
}

export interface UseSpaceBake {
  /** Create every storey's draft as IfcSpace. Never throws. */
  createAllSpaces: () => SpaceBakeResult;
  /** Every expressId this tool has authored, across all storeys. */
  createdIds: () => number[];
}

export function useSpaceBake({
  sketchModelId,
  ifcDataStore,
  boundaryMode,
  sessionsRef,
  floorToFloor,
  coordinateInfo,
}: UseSpaceBakeOptions): UseSpaceBake {
  const addSpace = useViewerStore((s) => s.addSpace);
  const removeEntity = useViewerStore((s) => s.removeEntity);

  // IfcSpace expressIds this tool created per storey — so confirming again
  // replaces the spaces it dropped instead of duplicating.
  const generatedRef = useRef<Map<number, number[]>>(new Map());

  /**
   * IfcSpace is class-hidden by default (TYPE_VISIBILITY_SEMANTIC_DEFAULTS).
   * Flip the toggle on after creating spaces so the user sees what they just
   * created — and, since the toggle persists, so the spaces stay visible when
   * the exported file is reopened.
   */
  const revealSpaces = useCallback(() => {
    const s = useViewerStore.getState();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
  }, []);

  /**
   * Create one storey's draft rooms as real IfcSpace. (1) Replace: remove the
   * spaces this tool previously created on the storey. (2) Skip rooms that
   * overlap an existing authored space (dedup, decided in `space-bake.ts`).
   * (3) Emit each via `addSpace`, which mirrors a mesh into the 3D scene
   * immediately. Returns counts.
   */
  const createSpacesForStorey = useCallback((
    sid: number,
    rooms: DraftRoom[],
    authored: Pt[][],
    frame: StoreyPlanFrame,
  ): { emitted: number; skipped: number; error: string | null } => {
    if (!sketchModelId) return { emitted: 0, skipped: 0, error: 'no model to create spaces in' };
    for (const id of generatedRef.current.get(sid) ?? []) removeEntity(sketchModelId, id);
    generatedRef.current.delete(sid);
    const { planned, skipped } = planStoreySpaces(rooms, authored, floorToFloor(sid));
    const { dx, dy } = roomFrameToModelWorld(coordinateInfo);
    const roomToWorld = (p: Pt): Pt => [p[0] + dx, p[1] + dy];
    const newIds: number[] = [];
    // An addSpace failure (anchor resolution, missing mutation view, …) is
    // NOT an "already a space" skip — keep the first error so the status
    // line tells the user the truth instead of silently dropping spaces
    // that would then be missing from the export.
    let error: string | null = null;
    for (const space of planned) {
      // `OuterCurve` is the engine's net/gross/centre outline; gross area stays
      // on the centreline and net area stays on the inner face, so neither
      // quantity is at the mercy of which boundary the user chose to emit.
      // The name counts SUCCESSFUL emissions, so a failed space does not leave
      // a gap in the numbering the user can see.
      const res = addSpace(sketchModelId, sid, {
        Profile: 'polygon',
        // `addSpace` anchors the profile to the storey's own placement, so the
        // reader applies the storey's whole chain (storey axis ∘ building ∘
        // site) to these points. Handing it the room frame — which already has
        // that chain baked in, because it comes from rendered geometry — would
        // have the chain applied a second time. Divide it out here. Areas are
        // measured in `space-bake.ts` and are invariant under a rigid motion,
        // so only the curve moves.
        OuterCurve: space.OuterCurve.map((p) => toStoreyLocal(frame, roomToWorld(p))),
        Height: space.Height,
        Name: `Space ${newIds.length + 1}`,
        ObjectType: GENERATED_SPACE_OBJECTTYPE,
        grossFloorArea: space.grossFloorArea,
        netFloorArea: space.netFloorArea,
      },
      // Draw the immediate 3D mirror on the room outline, which is where the
      // ghost that previewed it is (`useSpaceGhostPreview` hands
      // `buildElementMesh` these same coordinates). The profile above has the
      // storey chain divided out and `buildElementMesh` does not put it back,
      // so passing the profile would make the room jump by the whole chain the
      // moment it is confirmed and come back on reload.
      //
      // This keeps the mirror exactly where it was, no better: `buildElementMesh`
      // reads no `CoordinateInfo`, so on a georeferenced model both it and the
      // ghost sit `roomFramePlanOffsets` away from the rendered walls. That is
      // the room frame's own question, decided in `wall-rects-from-meshes.ts`
      // and not here — correcting it on one of the two would split them apart.
      space.OuterCurve);
      if (res && 'expressId' in res) newIds.push(res.expressId);
      else error ??= (res && 'error' in res ? res.error : 'unknown error');
    }
    generatedRef.current.set(sid, newIds);
    return { emitted: newIds.length, skipped, error };
  }, [sketchModelId, removeEntity, addSpace, floorToFloor, coordinateInfo]);

  /**
   * Confirm: turn EVERY storey's collected draft into IfcSpace at once — the
   * single create path, run on close. Reads each per-storey session's rooms at
   * the active boundary mode and dedupes against existing authored spaces.
   */
  const createAllSpaces = useCallback((): SpaceBakeResult => {
    // Report a real error rather than a silent zero: `confirmCreate` treats a
    // null error as success and closes the tool, which would discard every
    // draft the user has drawn. `sketchModelId` is genuinely reachable as null
    // — with several models loaded and none active we deliberately refuse to
    // guess which one to author into, rather than picking an arbitrary one.
    if (!sketchModelId) {
      return { emitted: 0, floors: 0, error: 'No active model — pick one in the model list, then confirm again.' };
    }
    if (!ifcDataStore) {
      return { emitted: 0, floors: 0, error: 'Model data is still loading — confirm again in a moment.' };
    }
    const authoredMap = existingSpaceFootprintsByStorey(ifcDataStore);
    const { dx, dy } = roomFrameToModelWorld(coordinateInfo);
    let emitted = 0, floors = 0;
    let firstError: string | null = null;
    for (const [sid, session] of sessionsRef.current) {
      if (!session.alive || session.roomCount === 0) continue;
      // The one frame this storey's rooms are written through, and read back
      // through. Refusing is the whole point of a null here: a storey whose
      // chain will not resolve, or that tips out of plan, has no honest planar
      // inverse, and a room authored without one is turned rather than
      // visibly broken — nobody notices until it is quoted in a schedule.
      const frame = storeyPlanFrame(ifcDataStore, sid);
      if (!frame) {
        firstError ??= `Storey #${sid}: placement not resolvable in plan — its rooms were not created.`;
        continue;
      }
      const rooms = session.rooms().map((r) => ({
        outline: r.outline,
        boundary: session.boundaryOutline(r.face, boundaryMode),
        // Always the inner face, independent of `boundaryMode` — so
        // NetFloorArea stays net even when the user emits "outer" as the
        // room's OuterCurve.
        inner: session.boundaryOutline(r.face, 'inner'),
      }));
      // `existingSpaceFootprintsByStorey` returns STOREY-LOCAL footprints, and
      // `planStoreySpaces` compares them against drafts in the room frame. Fold
      // them the other way so the dedup compares like with like; left as they
      // are, the overlap test matches nothing on a placed storey and confirm
      // lays a second room on top of every one already in the file.
      const authored = (authoredMap.get(sid) ?? []).map((ring) => ring.map((p): Pt => {
        const w = fromStoreyLocal(frame, p);
        return [w[0] - dx, w[1] - dy];
      }));
      const res = createSpacesForStorey(sid, rooms, authored, frame);
      emitted += res.emitted;
      if (res.emitted) floors++;
      firstError ??= res.error;
    }
    if (emitted > 0) revealSpaces();
    return { emitted, floors, error: firstError };
  }, [sketchModelId, ifcDataStore, boundaryMode, sessionsRef, createSpacesForStorey, revealSpaces, coordinateInfo]);

  const createdIds = useCallback((): number[] => {
    const out: number[] = [];
    for (const ids of generatedRef.current.values()) out.push(...ids);
    return out;
  }, []);

  return { createAllSpaces, createdIds };
}
