/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assembles `runOwnerSeed`'s dependencies for `collabSlice.startCollab`
 * (#4446). The slice keeps every STORE write (the phase / progress / failure
 * mirrors are its callbacks); this module only composes the runtime-facing
 * halves — the blob-store factory, the lazily loaded IFCX importer, the
 * placement-baseline stamp and the relay confirmation — so the slice stays a
 * short call rather than a forty-line object literal.
 */

import type { CollabSession, ModelSlotRef } from '@ifc-lite/collab';
import type { ViewerModelPayload } from '@/hooks/ingest/viewerModelIngest';
import { createSharedBlobStore } from './blob-store';
import type { CollabGeomApi } from './geometry-sync';
import type { CollabSeedInput, OwnerSeedDeps } from './owner-seed';
import { confirmRelayHoldsState } from './relay-confirm';

export type CollabRuntime = typeof import('@ifc-lite/collab');

export interface OwnerSeedWiring {
  session: CollabSession;
  seed: CollabSeedInput;
  collab: CollabRuntime;
  geomApi: CollabGeomApi;
  /** `collabServerUrl()` at join time; `null` for a local-only session. */
  serverUrl: string | null;
  roomId: string;
  token: string | undefined;
  roomModels: ReadonlyMap<string, ModelSlotRef>;
  /** The viewer's IFCX importer, already lazy-loaded by the slice (code-split). */
  parseIfcx: (buffer: ArrayBuffer) => Promise<ViewerModelPayload>;
  isCurrent: () => boolean;
  onPhase: OwnerSeedDeps['onPhase'];
  onProgress: OwnerSeedDeps['onProgress'];
}

export function buildOwnerSeedDeps(wiring: OwnerSeedWiring): OwnerSeedDeps {
  const { session, collab, serverUrl, roomId, token, isCurrent } = wiring;
  return {
    session,
    seed: wiring.seed,
    collab,
    geomApi: wiring.geomApi,
    makeBlobStore: () => createSharedBlobStore(collab, serverUrl, token),
    parseIfcx: wiring.parseIfcx,
    roomModels: wiring.roomModels,
    // Record the placement each entity's blob is baked at, so every client
    // (incl. late joiners) can render `blob + (current usd::xformop −
    // baseline)`. The blob is baked at whatever placement the doc holds now:
    // the seeded `usd::xformop` for IFCX models, identity for legacy STEP
    // (geometry baked world-absolute).
    stampBaseline: (path) => {
      if (path) {
        const current = collab.getEntityPlacement(session.doc, path);
        collab.setPlacementBaseline(session.doc, path, current ?? { location: [0, 0, 0] });
      }
      return path;
    },
    isCurrent,
    // 'ready' means the relay holds it, not that the browser queued it (#4446).
    confirmRelay: () =>
      confirmRelayHoldsState({
        collab,
        serverUrl,
        roomId,
        token,
        stateVector: session.captureBaseline(),
        isCurrent,
      }),
    onPhase: wiring.onPhase,
    onProgress: wiring.onProgress,
  };
}
