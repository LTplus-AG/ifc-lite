/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `confirmRelayHoldsState` (#4446): keeps asking the relay until its state
 * vector covers the owner's, gives up at the budget, stops the moment the
 * join is abandoned, and has nothing to confirm without a relay. The cover
 * check is the real `stateVectorCovers` over a real session's state vector;
 * only the socket read is scripted — a relay that catches up one owner write
 * per probe. (Each `set` of a fresh key is one Yjs struct, so a client's
 * clock after N such writes is N.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabSession, stateVectorCovers, type CollabSession } from '@ifc-lite/collab';
import { confirmRelayHoldsState } from './relay-confirm.js';

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

describe('confirmRelayHoldsState (#4446)', () => {
  it('polls until the relay has caught up, then confirms', async () => {
    const owner = await ownerWith(2);
    try {
      const relay = laggingRelay(owner.clientId, 0, 2);
      const ok = await confirmRelayHoldsState(relay.collab, 'ws://relay', 'r', 't', owner.captureBaseline(), () => true, { intervalMs: 1 });
      assert.equal(ok, true);
      assert.equal(relay.probes(), 3, 'two probes said "behind" (clock 0, then 1), the third covered');
    } finally {
      owner.dispose();
    }
  });

  it('gives up at the budget when the relay never catches up', async () => {
    const owner = await ownerWith(1);
    try {
      const relay = laggingRelay(owner.clientId, 0, 0);
      const ok = await confirmRelayHoldsState(relay.collab, 'ws://relay', 'r', 't', owner.captureBaseline(), () => true, { timeoutMs: 40, intervalMs: 5 });
      assert.equal(ok, false);
      assert.ok(relay.probes() >= 2, 'it kept asking until the budget ran out');
    } finally {
      owner.dispose();
    }
  });

  it('treats a failing probe as "not yet" and still confirms once one succeeds', async () => {
    const owner = await ownerWith(1);
    try {
      let calls = 0;
      const collab = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          calls++;
          if (calls === 1) throw new Error('socket closed before the handshake');
          return new Map([[owner.clientId, 1]]);
        },
      };
      assert.equal(await confirmRelayHoldsState(collab, 'ws://relay', 'r', 't', owner.captureBaseline(), () => true, { intervalMs: 1 }), true);
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
      const collab = {
        stateVectorCovers,
        fetchRoomStateVector: async () => {
          calls++;
          current = false; // Leave landed mid-probe
          return new Map<number, number>();
        },
      };
      const ok = await confirmRelayHoldsState(collab, 'ws://relay', 'r', 't', owner.captureBaseline(), () => current, { intervalMs: 1 });
      assert.equal(ok, false);
      assert.equal(calls, 1);
    } finally {
      owner.dispose();
    }
  });

  it('a local-only session (no relay) has nothing to confirm', async () => {
    const collab = {
      stateVectorCovers,
      fetchRoomStateVector: async () => {
        throw new Error('must not be called');
      },
    };
    assert.equal(await confirmRelayHoldsState(collab, null, 'r', undefined, new Uint8Array([0]), () => true), true);
  });
});
