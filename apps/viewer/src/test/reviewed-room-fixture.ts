/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { MODEL, seedNativeSdkModel, settle } from './native-sdk-model';
import { nativeRootName } from '@/lib/actions/native-edit-evidence';
import { readOnlyModelEditTarget } from '@/lib/actions/model-authoring-read-target';
import { parseRoomProposal } from '@/lib/actions/room-command-proposal';
import { effectiveMetadataRecord } from '@ifc-lite/parser';

export async function seedReviewedRoom(points: [number, number, number][] = [[20,20,0],[24,20,0],[24,23,0],[20,23,0]], sourceBytes?: Uint8Array) {
  const native = await seedNativeSdkModel(sourceBytes);
  for (const [i, Start] of points.entries()) native.adapter.addWall(MODEL, 42, { Start, End: points[(i + 1) % points.length], Thickness: .2, Height: 3 });
  await settle();
  return native;
}

export function roomEnvelope(command: Record<string, unknown> = { action: 'auto' }, extra: Record<string, unknown> = {}) {
  const reader = readOnlyModelEditTarget(useViewerStore.getState(), MODEL);
  if (!reader) throw new Error('The actual native Room fixture is unavailable');
  return { version: 1, kind: 'room.command', title: 'Prepared native rooms', modelId: MODEL,
    storey: { GlobalId: effectiveMetadataRecord(reader.dataStore, 42, reader.view)?.attributes[0], Name: nativeRootName(reader, 42) }, units: 'm', frame: 'storey-local',
    command: { weld: .05, minArea: .3, boundary: 'inner', height: 3, z: 0, namePattern: 'Reviewed {n}', ...command }, ...extra };
}
export const roomProposal = (command?: Record<string, unknown>, extra?: Record<string, unknown>) => parseRoomProposal(JSON.stringify(roomEnvelope(command, extra)));
