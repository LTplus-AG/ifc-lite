/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `confirmRelayHoldsState` (#4446): keeps asking the relay until its state
 * vector covers the owner's, backs off between probes, charges the
 * unreachable budget only to failing probes, caps the whole wait, stops the
 * moment the join is abandoned, and has nothing to confirm without a relay.
 * The cover check is the real `stateVectorCovers` over a real session's state
 * vector; only the socket read is scripted — a relay that catches up one
 * owner write per probe. (Each `set` of a fresh key is one Yjs struct, so a
 * client's clock after N such writes is N.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabSession, stateVectorCovers, type CollabSession } from '@ifc-lite/collab';
import { confirmRelayHoldsState, type ConfirmRelayInput, type RelayProbe } from './relay-confirm.js';

const user = { id: 'owner', name: 'Owner', color: '#000' };

/** A memory session with `writes` fresh keys set, i.e. an own clock of `writes`. */
async function ownerWith(writes: number): Promise<CollabSession> {
  const session = await createCollabSession({ roomId: `relay-${Math.random()}`, user, provider: 'memory' });
  for (let i = 0; i < writes; i++) session.doc.getMap('m').set(`k${i}`, i);
  return session;
}

/** A relay whose held clock for the owner advances by one per probe, starting at `from`. */
function laggingRelay(clientId: number, from: number, upTo: number) {
  let probes = 0;
  return {
    probes: () => probes,
    collab: {
      stateVectorCovers,
      fetchRoomStateVector: async () => {
        const clock = Math.min(from + probes, upTo);
        probes++;
        return new Map<number, number>(clock > 0 ? [[clientId, clock]] : []);
      },
    },
  };
}

function inputFor(
  owner: CollabSession,
  collab: RelayProbe,
  overrides: Partial<ConfirmRelayInput> = {},
): ConfirmRelayInput {
  return {
    collab,
    serverUrl: 'ws://relay',
    roomId: 'r',
    token: 't',
    stateVector: owner.captureBaseline(),
    isCurrent: () => true,
    intervalMs: 1,
    ...overrides,
  };
}

describe('confirmRelayHoldsState (#4446)', () => {
  it('polls until the relay has caught up, then confirms', async () => {
    const owner = await ownerWith(2);
    try {
      const relay = laggingRelay(owner.clientId, 0, 2);
      assert.equal(await confirmRelayHoldsState(inputFor(owner, relay.collab)), true);
      assert.equal(relay.probes(), 3, 'two probes said "behind" (clock 0, then 1), the third covered');
    } finally {
      owner.dispose();
    }
  });

  it('a reachable relay that is still behind is waited for past the unreachable budget, up to the hard cap', async () => {
    const owner = await ownerWith(1);
    try {
      const relay = laggingRelay(owner.clientId, 0, 0);
      const t0 = Date.now();
      const ok = await confirmRelayHoldsState(
        inputFor(owner, relay.collab, { unreachableMs: 5, maxWaitMs: 60, intervalMs: 2, maxIntervalMs: 4 }),
      );
      assert.equal(ok, false);
      assert.ok(Date.now() - t0 >= 55, 'the 5 ms unreachable budget did not apply to a relay that answered');
      assert.ok(relay.probes() >= 5, 'it kept asking until the cap');
    } finally {
      owner.dispose();
    }
  });

  it('gives up once the relay has been out of reach for the whole budget', async () => {
    const owner = await ownerWith(1);
    try {
      let calls = 0;
      const collab: RelayProbe = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          calls++;
          throw new Error('ECONNREFUSED');
        },
      };
      const t0 = Date.now();
      const ok = await confirmRelayHoldsState(inputFor(owner, collab, { unreachableMs: 30, maxWaitMs: 5_000, intervalMs: 2, maxIntervalMs: 4 }));
      assert.equal(ok, false);
      assert.ok(Date.now() - t0 < 2_000, 'the unreachable budget, not the hard cap, ended the wait');
      assert.ok(calls >= 3, 'it retried while the budget lasted');
    } finally {
      owner.dispose();
    }
  });

  it('backs off between probes: 250 → 500 → 1000 ms, capped, first probe immediate', async () => {
    const owner = await ownerWith(1);
    try {
      const at: number[] = [];
      const relay = laggingRelay(owner.clientId, 0, 0);
      const collab: RelayProbe = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          at.push(Date.now());
          return relay.collab.fetchRoomStateVector();
        },
      };
      const t0 = Date.now();
      await confirmRelayHoldsState(inputFor(owner, collab, { intervalMs: 20, maxIntervalMs: 80, maxWaitMs: 300 }));
      assert.ok(at[0] - t0 < 15, 'first probe fired immediately');
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      // Timer resolution is coarse; check the ordering and the cap rather than exact values.
      assert.ok(gaps.length >= 4, `expected several probes, got gaps ${gaps.join(',')}`);
      assert.ok(gaps[0] >= 18 && gaps[0] < 60, `first gap ~20 ms, got ${gaps[0]}`);
      assert.ok(gaps[1] >= 38 && gaps[1] < 100, `second gap ~40 ms, got ${gaps[1]}`);
      assert.ok(gaps.slice(2).every((g) => g >= 78 && g < 200), `later gaps capped at ~80 ms, got ${gaps.slice(2).join(',')}`);
    } finally {
      owner.dispose();
    }
  });

  it('treats a failing probe as "not yet" and still confirms once one succeeds', async () => {
    const owner = await ownerWith(1);
    try {
      let calls = 0;
      const collab: RelayProbe = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          calls++;
          if (calls === 1) throw new Error('socket closed before the handshake');
          return new Map([[owner.clientId, 1]]);
        },
      };
      assert.equal(await confirmRelayHoldsState(inputFor(owner, collab)), true);
      assert.equal(calls, 2);
    } finally {
      owner.dispose();
    }
  });

  it('stops probing the moment the join is abandoned', async () => {
    const owner = await ownerWith(1);
    try {
      let current = true;
      let calls = 0;
      const collab: RelayProbe = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          calls++;
          current = false; // Leave landed mid-probe
          return new Map<number, number>();
        },
      };
      assert.equal(await confirmRelayHoldsState(inputFor(owner, collab, { isCurrent: () => current })), false);
      assert.equal(calls, 1);
    } finally {
      owner.dispose();
    }
  });

  it('a local-only session (no relay) has nothing to confirm', async () => {
    const collab: RelayProbe = {
      stateVectorCovers,
      fetchRoomStateVector: async () => {
        throw new Error('must not be called');
      },
    };
    assert.equal(
      await confirmRelayHoldsState({ collab, serverUrl: null, roomId: 'r', token: undefined, stateVector: new Uint8Array([0]), isCurrent: () => true }),
      true,
    );
  });
});
