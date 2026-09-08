/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Select elements in this zone" must work inside a collaborative room.
 *
 * The collab recipient seeds its room model through `upsertModel` alone
 * (`collabSlice.ts`, "First build: register a real model record") and never
 * calls `registerModelOffset`. `FederationRegistry.fromGlobalId` only knows
 * the ranges handed to it by `registerModelOffset`, so it answers `null` for
 * every id in the room — and `resolveZoneSelection` drops what it cannot
 * place. The result was a silent no-op: the zone matched its elements and
 * selected none of them.
 *
 * Sibling fix to PR #2697, which found the same registry-vs-store split on
 * the clash path. Both resolve through the store's canonical
 * `resolveGlobalIdFromModels` instead of the registry singleton.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import { selectElementsInZone } from './useZoneSelection.js';
import type { ZoneAssignment, ZoneAssignmentsByElement } from '@/lib/zones/types';
import { entityRefToString, type FederatedModel } from '@/store/types';

const ROOM_ID = 'abc123';
const ROOM_MODEL_ID = `room:${ROOM_ID}`;
const SET = 'zone-set-1';
const ZONE = 'zone-a';

function assignment(overrides: Partial<ZoneAssignment>): ZoneAssignment {
  return { zoneId: null, zoneName: null, straddles: false, touchedZoneIds: [], ...overrides };
}

/** Express ids as a reconstructed room store hands them out: raw, dense, small. */
const ROOM_ELEMENT_IDS = [12, 34, 56];
const MAX_EXPRESS_ID = 100;

function roomAssignments(): ZoneAssignmentsByElement {
  const map: ZoneAssignmentsByElement = new Map();
  for (const id of ROOM_ELEMENT_IDS) {
    map.set(id, { [SET]: assignment({ zoneId: ZONE, zoneName: 'A', touchedZoneIds: [ZONE] }) });
  }
  return map;
}

/**
 * Seed the store exactly the way the collab recipient does: `upsertModel`
 * with a `room:<roomId>` id, `idOffset: 0`, a real `maxExpressId`, and NO
 * `registerModelOffset` call. Copied field-for-field from `collabSlice.ts`.
 */
function seedRoomModelLikeCollabSlice(): void {
  const state = useViewerStore.getState();
  state.clearAllModels();
  state.upsertModel({
    id: ROOM_MODEL_ID,
    name: 'Shared model',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: Date.now(),
    fileSize: 0,
    idOffset: 0,
    maxExpressId: MAX_EXPRESS_ID,
    loadState: 'complete',
  } as FederatedModel);
}

describe('zones: select-in-zone inside a collaborative room (sibling of PR #2697)', () => {
  beforeEach(() => {
    seedRoomModelLikeCollabSlice();
    useViewerStore.setState({ zoneAssignments: roomAssignments() });
  });

  it('setup sanity: the room model is in the store but NOT in the federation registry', () => {
    const state = useViewerStore.getState();
    assert.ok(state.models.get(ROOM_MODEL_ID), 'room model must be in state.models');
    // This is the defect's precondition, not the defect itself.
    assert.equal(
      state.fromGlobalId(ROOM_ELEMENT_IDS[0]),
      null,
      'the registry must not know the room model — that is what makes the bug reachable',
    );
  });

  it('selects every element in the zone (it must not be a silent no-op)', () => {
    const count = selectElementsInZone(SET, ZONE);
    assert.equal(count, ROOM_ELEMENT_IDS.length, 'every zone member must be selected');
  });

  it('drives BOTH selection channels with the room model id', () => {
    selectElementsInZone(SET, ZONE);
    const state = useViewerStore.getState();

    assert.deepEqual(
      [...state.selectedEntityIds].sort((a, b) => a - b),
      [...ROOM_ELEMENT_IDS].sort((a, b) => a - b),
      'highlight channel must carry the zone members',
    );

    // The model-aware channel keys refs as `modelId:expressId`
    // (`entityRefToString`), so it pins the model id AND the express id.
    assert.deepEqual(
      [...state.selectedEntitiesSet].sort(),
      ROOM_ELEMENT_IDS.map((id) => entityRefToString({ modelId: ROOM_MODEL_ID, expressId: id })).sort(),
      'refs must name the room model (not `legacy`) with the express ids unchanged at idOffset 0',
    );
  });

  it('still drops an id no loaded model owns, so the count matches the highlight', () => {
    const withStranger = roomAssignments();
    // Above the room model's maxExpressId and outside every other model:
    // nothing owns it, so it must not be selected or counted.
    withStranger.set(9999, { [SET]: assignment({ zoneId: ZONE, zoneName: 'A', touchedZoneIds: [ZONE] }) });
    useViewerStore.setState({ zoneAssignments: withStranger });

    const count = selectElementsInZone(SET, ZONE);
    assert.equal(count, ROOM_ELEMENT_IDS.length, 'the unowned id must not inflate the toast count');
    assert.equal(
      useViewerStore.getState().selectedEntityIds.has(9999),
      false,
      'the unowned id must not be highlighted',
    );
  });
});
