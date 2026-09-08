/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Room-id composition and parsing (`src/sync/room.ts`, spec §10).
 *
 * `parseRoomId` is exported from the package root but had no caller and
 * no test — a mutation that split on the LAST slash instead of the first,
 * and one that swapped the two fields of the slashless result, both
 * survived the whole suite.
 */

import { describe, expect, it } from 'vitest';
import { federationRoomId, parseRoomId, roomIdFor } from '../src/sync/room.js';

describe('roomIdFor / federationRoomId', () => {
  it('composes `project/model`', () => {
    expect(roomIdFor({ projectId: 'proj-1', modelId: 'arch' })).toBe('proj-1/arch');
  });

  it('names the federation room `project/_federation`', () => {
    expect(federationRoomId('proj-1')).toBe('proj-1/_federation');
    // The federation room is a room of the SAME project, so it must parse
    // back to that project id — a session joining it derives the project
    // from the room id.
    expect(parseRoomId(federationRoomId('proj-1')).projectId).toBe('proj-1');
  });
});

describe('parseRoomId', () => {
  it('splits at the FIRST separator, so a model id may contain slashes', () => {
    // Model ids are caller-supplied (upload paths, S3 keys, nested folder
    // names). Splitting at the last slash would attribute
    // `proj-1/site-a/arch` to project `proj-1/site-a`, and the peer would
    // join a room nobody else is in.
    expect(parseRoomId('proj-1/site-a/arch')).toEqual({
      projectId: 'proj-1',
      modelId: 'site-a/arch',
    });
  });

  it('round-trips every roomIdFor output, slashy model ids included', () => {
    for (const desc of [
      { projectId: 'p', modelId: 'm' },
      { projectId: 'proj-1', modelId: 'site-a/arch' },
      { projectId: 'proj-1', modelId: '' },
    ]) {
      expect(parseRoomId(roomIdFor(desc))).toEqual(desc);
    }
  });

  it('treats a separator-less id as a bare model in no project', () => {
    // The legacy single-model form. The id is the MODEL, not the project:
    // reading it as a project would leave the session with no model to
    // open.
    expect(parseRoomId('legacy-room')).toEqual({ projectId: '', modelId: 'legacy-room' });
  });

  it('keeps an empty model id when the separator is trailing', () => {
    expect(parseRoomId('proj-1/')).toEqual({ projectId: 'proj-1', modelId: '' });
  });
});
