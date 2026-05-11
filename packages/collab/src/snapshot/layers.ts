/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-user layer extraction.
 *
 * Composed with the baseline they fork from, these layers reproduce the
 * full live state — that's the IFCX layer composition contract from spec
 * §2 / §10.
 *
 * v0.1 strategy: "snapshot of current state, scoped to one client" by
 * applying the *full* update history to a fresh replay doc, not just the
 * post-baseline diff. The diff-only approach can't render IFCX nodes for
 * entities created before the baseline (their parent struct isn't in the
 * filtered update). The full-history approach correctly renders any
 * entity the client has touched, with all of that client's writes
 * reflected — at the cost of also including their pre-baseline writes.
 *
 * v0.7 (branching) introduces a proper layer composer that produces
 * minimal-diff layers; the v0.1 implementation is the foundation.
 */

import type { IfcxFile } from '@ifc-lite/ifcx';
import * as Y from 'yjs';
import { createCollabDoc } from '../doc/schema.js';
import { snapshotToIfcx, type SnapshotOptions } from './to-ifcx.js';

export interface LayerExtractionOptions {
  /** clientID to filter to. If omitted, all clients are included. */
  clientId?: number;
  /** Forwarded to `snapshotToIfcx` for header/timestamp control. */
  snapshot?: SnapshotOptions;
}

/**
 * Capture a baseline state vector. Composed-with-baseline IFCX layer
 * composition is the v0.7 mode; for v0.1 we still expose this so callers
 * can pin a "before" point for downstream tooling.
 */
export function captureBaseline(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * Extract a per-user IFCX layer from `doc`.
 *
 * Replays `doc`'s full state filtered by `clientId` onto a fresh doc and
 * snapshots that. The resulting IFCX is a complete description of every
 * entity the chosen client touched, with that client's view of the
 * attributes.
 *
 * `baseline` is currently unused at the per-write level (the v0.1
 * limitation noted above) but kept in the signature so callers don't have
 * to refactor when the v0.7 differential mode lands.
 */
export function extractUserLayer(
  doc: Y.Doc,
  baseline: Uint8Array | undefined,
  options: LayerExtractionOptions = {},
): IfcxFile {
  void baseline;
  const fullUpdate = Y.encodeStateAsUpdate(doc);
  const filtered =
    options.clientId !== undefined ? filterUpdateByClient(fullUpdate, options.clientId) : fullUpdate;

  const replay = createCollabDoc({ gc: false });
  if (filtered.byteLength > 0) {
    Y.applyUpdate(replay, filtered);
  }
  return snapshotToIfcx(replay, {
    author: options.clientId !== undefined ? `client-${options.clientId}` : undefined,
    ...options.snapshot,
  });
}

/**
 * Filter a Y update so it only contains operations from `clientId`.
 *
 * We use Yjs's diff-against-state-vector machinery: build a state
 * vector that has every client *except* `clientId` advanced past the
 * end of the input update, then `diffUpdate` returns just `clientId`'s
 * structs.
 */
export function filterUpdateByClient(update: Uint8Array, clientId: number): Uint8Array {
  const tmp = createCollabDoc({ gc: false });
  Y.applyUpdate(tmp, update);
  const sv = Y.encodeStateVectorFromUpdate(update);
  const decoded = decodeStateVector(sv);
  // Keep our client at clock 0 so we receive all of its ops; advance
  // every other client to their final clock so they're excluded.
  decoded.delete(clientId);
  const adjusted = encodeStateVector(decoded);
  return Y.encodeStateAsUpdate(tmp, adjusted);
}

/* -------------------- minimal SV codec helpers ---------------------- */

import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

function decodeStateVector(buf: Uint8Array): Map<number, number> {
  const decoder = decoding.createDecoder(buf);
  const ssLen = decoding.readVarUint(decoder);
  const map = new Map<number, number>();
  for (let i = 0; i < ssLen; i++) {
    const client = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    map.set(client, clock);
  }
  return map;
}

function encodeStateVector(map: Map<number, number>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, map.size);
  for (const [client, clock] of map) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, clock);
  }
  return encoding.toUint8Array(encoder);
}
