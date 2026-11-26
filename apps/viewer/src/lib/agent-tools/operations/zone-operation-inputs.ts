/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { ZoneSet } from '@/lib/zones/types';
import { zoneSetRevision } from '@/lib/zones/apportionment-cache';
import { zoneAssignmentSignature } from '@/lib/zones/assignment-signature';

type ViewerState = ReturnType<typeof useViewerStore.getState>;

/** Same own fields, by identity, except `ignored`. */
function sameExcept(a: object, b: object, ignored: string) {
  if (a === b) return true;
  const keys = Object.keys(a).filter(key => key !== ignored);
  // Some native meshes carry NaN for an unavailable proved volume.
  return keys.length === Object.keys(b).filter(key => key !== ignored).length
    && keys.every(key => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)));
}
/**
 * Geometry as the proved volumes read it. A recolour replaces every mesh with `{ ...mesh, color }`, and with it
 * `geometryResult` and the `models` Map, but keeps each mesh's buffers; any other change still differs (#10669).
 */
export function sameGeometry(a: ViewerState['geometryResult'] | undefined, b: ViewerState['geometryResult'] | undefined) {
  if (a === b) return true;
  if (!a || !b || a.meshes.length !== b.meshes.length || !sameExcept(a, b, 'meshes')) return false;
  return a.meshes.every((mesh, index) => sameExcept(mesh, b.meshes[index], 'color'));
}
/** Stricter than streaming-refresh's sameModelsExceptGeometry, which also ignores retained geometry. */
export function sameModels(a: ViewerState['models'], b: ViewerState['models']) {
  if (a === b) return true;
  return a.size === b.size && [...a].every(([id, model]) => {
    const other = b.get(id);
    return other !== undefined && sameExcept(model, other, 'geometryResult') && sameGeometry(model.geometryResult, other.geometryResult);
  });
}
/**
 * Capture the model, geometry and zone inputs the export reads before it awaits.
 * Geometry ticks also include appearance uploads. Compare the actual geometry and
 * model handles so a colour-only replacement can finish, and check the content
 * version for in-place federation realignment.
 */
export function captureZoneExportInputs(set: ZoneSet) {
  const { models, geometryResult, geometryContentVersion, mutationVersion, zoneAssignments } = useViewerStore.getState();
  const signature = zoneSetRevision(set), assignments = zoneAssignmentSignature(zoneAssignments, set.id);

  let invalidated = false;
  const release = useViewerStore.subscribe((now, previous) => {
    // Check each tick against the preceding write. A previous recolour cannot explain a later bare tick.
    if (now.geometryUpdateTick !== previous.geometryUpdateTick
      && now.models === previous.models && now.geometryResult === previous.geometryResult) invalidated = true;
  });

  function current() {
    const now = useViewerStore.getState();
    if (invalidated || now.geometryContentVersion !== geometryContentVersion || now.mutationVersion !== mutationVersion) return false;
    if (!sameModels(now.models, models) || !sameGeometry(now.geometryResult, geometryResult)) return false;
    const current = now.zoneSets.find(zoneSet => zoneSet.id === set.id);
    return current !== undefined && current.name === set.name && zoneSetRevision(current) === signature
      && zoneAssignmentSignature(now.zoneAssignments, set.id) === assignments;
  }
  return { current, release };
}
