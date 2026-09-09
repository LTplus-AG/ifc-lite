/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, SectionPlane, CameraState, ViewerBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef } from './model-compat.js';
import { toGlobalIdForRef } from '../../store/globalId.js';
import {
  resolvePresentationColorMap,
  resolvePresentationIds,
} from '../../lib/presentation/resolvePresentationIds.js';

const AXIS_TO_STORE: Record<string, 'down' | 'front' | 'side'> = {
  x: 'side',
  y: 'down',
  z: 'front',
};
const STORE_TO_AXIS: Record<string, 'x' | 'y' | 'z'> = {
  side: 'x',
  down: 'y',
  front: 'z',
};

export function createViewerAdapter(store: StoreApi): ViewerBackendMethods {
  // Tracks colors the SDK itself has applied. `pendingColorUpdates` in the store is a
  // one-shot signal: the geometry-streaming effect flushes it to the renderer and then
  // nulls it out, so it can't be read back later as "what's currently applied". This
  // closure survives that flush, so resetColors(refs) can compute "all SDK colors minus
  // refs" even after the effect has already run.
  let sdkColorOverrides = new Map<number, [number, number, number, number]>();

  return {
    colorize(refs: EntityRef[], color: [number, number, number, number]) {
      const state = store.getState();
      // Merge with existing pending colors (supports multiple colorize calls per script,
      // and survives the effect having already flushed+cleared pendingColorUpdates).
      const existing = state.pendingColorUpdates ?? sdkColorOverrides;
      const colorMap = new Map(existing);
      // #3338: the renderer looks each id up in its MESH set, so painting a
      // geometry-less `IfcElementAssembly` id paints nothing at all. Expand to
      // the parts that carry the meshes, exactly as isolate()/hide() do.
      const picked: Array<[number, [number, number, number, number]]> = [];
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        picked.push([toGlobalIdForRef(state.models, ref), color]);
      }
      for (const [id, c] of resolvePresentationColorMap(
        state.cameraCallbacks?.resolveHighlightIds,
        picked,
      )) {
        colorMap.set(id, c);
      }
      sdkColorOverrides = colorMap;
      state.setPendingColorUpdates(colorMap);
      return undefined;
    },
    colorizeAll(batches: Array<{ refs: EntityRef[]; color: [number, number, number, number] }>) {
      const state = store.getState();
      // Batch colorize: build the complete color map in a single call.
      // Avoids accumulation issues when React effects fire between calls.
      // #3338: same expansion as colorize() above, applied to the flattened
      // batches so an id repeated across batches keeps the last-wins order
      // this method already had.
      const picked: Array<[number, [number, number, number, number]]> = [];
      for (const batch of batches) {
        for (const ref of batch.refs) {
          if (!getModelForRef(state, ref.modelId)) continue;
          picked.push([toGlobalIdForRef(state.models, ref), batch.color]);
        }
      }
      const batchMap = resolvePresentationColorMap(
        state.cameraCallbacks?.resolveHighlightIds,
        picked,
      );
      sdkColorOverrides = batchMap;
      state.setPendingColorUpdates(batchMap);
      return undefined;
    },
    /**
     * Drop SDK colours: everything when called with no argument, otherwise
     * just the given entities.
     *
     * #3338: "the given entities" includes an assembly's `IfcRelAggregates`
     * PARTS, because `colorize` paints the parts (an assembly owns no mesh of
     * its own, so painting its bare id paints nothing). A reset that removed
     * only the parent id could not undo its own colorize.
     *
     * The consequence a script author should know about: `resetColors([
     * assemblyRef])` also clears a colour that was applied to one of those
     * parts DIRECTLY and independently, by an earlier `colorize([partRef])`.
     * This adapter tracks a flat id -> colour map with no record of which call
     * put each entry there, so it cannot tell the two apart. Reset the part
     * you care about and re-apply it, or reset by part rather than by
     * assembly, if that matters.
     */
    resetColors(refs?: EntityRef[]) {
      const state = store.getState();
      if (!refs || refs.length === 0) {
        // Set empty map to trigger scene.clearColorOverrides() (null skips the effect)
        sdkColorOverrides = new Map();
        state.setPendingColorUpdates(new Map());
        return undefined;
      }
      // Targeted reset: drop only the given entities from the known override set,
      // re-emitting whatever remains (same "empty map clears everything" contract above —
      // if nothing remains, this naturally clears everything too).
      const existing = state.pendingColorUpdates ?? sdkColorOverrides;
      const colorMap = new Map(existing);
      // #3338: colorize() wrote the assembly's PARTS, so a reset that deleted
      // only the parent id would leave every one of them painted.
      for (const id of resolvePresentationIds(
        state.cameraCallbacks?.resolveHighlightIds,
        refs.map((ref) => toGlobalIdForRef(state.models, ref)),
      )) {
        colorMap.delete(id);
      }
      sdkColorOverrides = colorMap;
      state.setPendingColorUpdates(colorMap);
      return undefined;
    },
    /**
     * Frame the camera on the bounds of the given refs, reusing the exact
     * global-id resolution `colorize()` above already performs: skip refs
     * whose model isn't loaded, resolve to global ids, then expand through
     * `resolvePresentationIds` so a geometry-less `IfcElementAssembly` id
     * (#3338) frames its parts instead of framing nothing. The resolved ids
     * are handed straight to `cameraCallbacks.frameEntities`, the same
     * federated-id callback `SearchModal.filter.tsx` already uses to frame a
     * search/filter result — it guards against degenerate/NaN bounds itself
     * (`Viewport.tsx`), so a non-geometric id in the mix can't fling the
     * camera off-model.
     */
    flyTo(refs: EntityRef[]) {
      const state = store.getState();
      const picked: number[] = [];
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        picked.push(toGlobalIdForRef(state.models, ref));
      }
      const ids = resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, picked);
      state.cameraCallbacks?.frameEntities?.(ids);
      return undefined;
    },
    setSection(section: SectionPlane | null) {
      const state = store.getState();
      if (section) {
        state.setSectionPlaneAxis?.(AXIS_TO_STORE[section.axis] ?? 'down');
        state.setSectionPlanePosition?.(section.position);
        if (section.flipped !== undefined && state.sectionPlane?.flipped !== section.flipped) {
          state.flipSectionPlane?.();
        }
        if (state.sectionPlane?.enabled !== section.enabled) {
          state.toggleSectionPlane?.();
        }
      } else {
        if (state.sectionPlane?.enabled) {
          state.toggleSectionPlane?.();
        }
      }
      return undefined;
    },
    getSection() {
      const state = store.getState();
      if (!state.sectionPlane?.enabled) return null;
      return {
        axis: STORE_TO_AXIS[state.sectionPlane.axis] ?? 'y',
        position: state.sectionPlane.position,
        enabled: state.sectionPlane.enabled,
        flipped: state.sectionPlane.flipped,
      };
    },
    /**
     * Applies position/target/up through `cameraCallbacks.applyViewpoint`,
     * the same store callback `lib/tours/snapshot.ts` and
     * `store/basket/basketViewActivator.ts` already use to restore a saved
     * camera pose from outside React. It takes a FULL `CameraViewpoint`
     * (`{ position, target, up, fov, projectionMode, orthoSize? }`, all
     * `{x,y,z}` objects — Viewport.tsx wires it straight to the renderer's
     * `Camera.setPosition/setTarget/setUp`, no axis remapping), so a partial
     * `CameraState` is merged onto `getViewpoint()`'s current values before
     * calling it — position/target/up are optional here and each defaults to
     * its current value if omitted. `CameraState`'s `[x, y, z]` tuples are the
     * only thing converted; the coordinate space itself is untouched.
     * `animate: false` matches `setCamera`'s prior behaviour of applying the
     * mode immediately with no transition.
     */
    setCamera(cameraState: Partial<CameraState>) {
      const state = store.getState();
      if (cameraState.mode) {
        state.setProjectionMode?.(cameraState.mode);
      }
      if (cameraState.position || cameraState.target || cameraState.up) {
        const current = state.cameraCallbacks?.getViewpoint?.();
        if (current) {
          const [px, py, pz] = cameraState.position ?? [
            current.position.x,
            current.position.y,
            current.position.z,
          ];
          const [tx, ty, tz] = cameraState.target ?? [
            current.target.x,
            current.target.y,
            current.target.z,
          ];
          const [ux, uy, uz] = cameraState.up ?? [current.up.x, current.up.y, current.up.z];
          state.cameraCallbacks?.applyViewpoint?.(
            {
              ...current,
              position: { x: px, y: py, z: pz },
              target: { x: tx, y: ty, z: tz },
              up: { x: ux, y: uy, z: uz },
            },
            false,
          );
        }
      }
      return undefined;
    },
    /**
     * Reads real position/target/up through `cameraCallbacks.getViewpoint` —
     * the same store callback `lib/tours/snapshot.ts` and
     * `store/slices/pinboardSlice.ts` already use to capture the live camera
     * from outside React (`Viewport.tsx` wires it straight to the renderer's
     * `Camera.getPosition/getTarget/getUp`) — so the documented
     * `createViewpoint({ camera: bim.viewer.getCamera() })` pattern gets a
     * real camera instead of a positionless one (#4264). No viewport mounted
     * (headless, or before first paint, when `cameraCallbacks` carries no
     * `getViewpoint`) falls back to `{ mode }` only, same as before.
     */
    getCamera(): CameraState {
      const state = store.getState();
      const mode = state.projectionMode ?? 'perspective';
      const viewpoint = state.cameraCallbacks?.getViewpoint?.();
      if (!viewpoint) return { mode };
      return {
        mode,
        position: [viewpoint.position.x, viewpoint.position.y, viewpoint.position.z],
        target: [viewpoint.target.x, viewpoint.target.y, viewpoint.target.z],
        up: [viewpoint.up.x, viewpoint.up.y, viewpoint.up.z],
      };
    },
  };
}
