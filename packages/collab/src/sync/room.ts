/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room lifecycle helpers.
 *
 * A room is identified by a string key. For a project-wide federated
 * session, room IDs follow the convention `project-id/model-id` plus
 * `project-id/_federation` (spec §10).
 */

export interface RoomDescriptor {
  projectId: string;
  modelId: string;
}

export function roomIdFor(desc: RoomDescriptor): string {
  return `${desc.projectId}/${desc.modelId}`;
}

export function federationRoomId(projectId: string): string {
  return `${projectId}/_federation`;
}

export function parseRoomId(roomId: string): RoomDescriptor {
  const idx = roomId.indexOf('/');
  if (idx < 0) {
    return { projectId: '', modelId: roomId };
  }
  return {
    projectId: roomId.slice(0, idx),
    modelId: roomId.slice(idx + 1),
  };
}
