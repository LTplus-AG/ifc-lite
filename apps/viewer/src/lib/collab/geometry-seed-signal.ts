/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Telling "this share has no geometry to send" apart from "this share's
 * geometry never arrived".
 *
 * Both look identical in the room: entities present, `geometry` map empty. The
 * viewer shipped for weeks with a room-wide geometry outage nobody saw,
 * because the owner swallowed the failed seed and reported success, and the
 * joiner's only warning was gated on the room already having geometry records,
 * i.e. it could not fire in the case that actually happened.
 *
 * Only the OWNER can separate the two: it is the one party that knows how many
 * meshes it had. So the owner stamps what it intended against what landed into
 * the doc's `meta` map, and the joiner reads that instead of guessing. The
 * marker rides the CRDT channel, which is independent of the blob HTTP
 * endpoint, so a blob-store outage still delivers it; it is exactly as durable
 * as the structure it annotates (if the room's doc never persists, both are
 * gone together and the joiner is back to "cannot tell", which is why the
 * no-marker case below stays silent).
 */

import type { CollabSession } from '@ifc-lite/collab';
import type { SeedGeometryReport } from './geometry-sync';

/** Key under the doc's top-level `meta` map (schema `TOP.META`). */
export const GEOMETRY_SEED_META_KEY = 'geometrySeed';

/** What the owner intended to seed, against what actually landed. */
export interface GeometrySeedMarker {
  /** Meshes the owner had. `0` is the positive assertion "nothing to seed". */
  expected: number;
  /** Meshes whose blob landed and got a doc ref. */
  seeded: number;
  /** Blob uploads that failed after retries. */
  failed: number;
  /** True when the upload phase stopped early (the store refused everything). */
  abandoned: boolean;
  /** ISO timestamp of the seed attempt. */
  at: string;
}

export type SeedOutcome =
  /** The model had no geometry to share. Legitimate: never warn. */
  | 'nothing-to-seed'
  /** Every mesh the model had is now in the room. */
  | 'seeded'
  /** Some meshes landed, some did not. */
  | 'partial'
  /** The model had geometry and the room got none of it. */
  | 'failed';

/**
 * The boundary, in one place.
 *
 * `offered === 0` is the ONLY thing that makes silence correct. Dropping that
 * term (classifying on `seeded === 0` alone) turns every structure-only or
 * empty model into a false alarm, and an alarm that cries wolf is how the
 * original outage stayed invisible.
 */
export function classifySeed(report: SeedGeometryReport | null | undefined): SeedOutcome {
  if (!report || report.offered === 0) return 'nothing-to-seed';
  if (report.seeded === 0) return 'failed';
  if (report.failed > 0 || report.seeded < report.attempted) return 'partial';
  return 'seeded';
}

/**
 * Owner-facing message for a share that did not fully seed, or `null` when the
 * share is fine (including the legitimately geometry-less one).
 */
export function seedFailureMessage(report: SeedGeometryReport | null | undefined): string | null {
  const outcome = classifySeed(report);
  if (!report || outcome === 'nothing-to-seed' || outcome === 'seeded') return null;
  if (outcome === 'partial') {
    return `Shared, but ${report.failed} of ${report.attempted} geometry uploads failed. People joining this link will be missing some elements.`;
  }
  if (report.abandoned) {
    return 'Geometry upload failed: the server is refusing uploads. People joining this link will see the model structure but no 3D geometry.';
  }
  if (report.failed > 0) {
    return 'Geometry upload failed. People joining this link will see the model structure but no 3D geometry.';
  }
  if (report.skipped.empty > 0 && report.attempted === 0) {
    return "This model's geometry is no longer in memory, so it could not be shared. Reload the model and share again.";
  }
  return 'No geometry could be shared for this model. People joining this link will see the model structure but no 3D geometry.';
}

/** Minimal doc surface: the top-level `meta` Y.Map. Keeps yjs out of imports. */
type SeedMetaDoc = CollabSession['doc'];

function metaMapOf(doc: SeedMetaDoc): { get(key: string): unknown; set(key: string, value: unknown): unknown } {
  // Top-level shared type `TOP.META` from @ifc-lite/collab's doc schema. Free
  // form and NOT emitted by `snapshotToIfcx` (that reads only header/imports/
  // schemas), so stamping here is invisible to the joiner's IFCX rebuild.
  return doc.getMap('meta') as unknown as {
    get(key: string): unknown;
    set(key: string, value: unknown): unknown;
  };
}

/** Stamp the seed attempt into the room. Called once, after the attempt. */
export function writeGeometrySeedMarker(doc: SeedMetaDoc, marker: GeometrySeedMarker): void {
  metaMapOf(doc).set(GEOMETRY_SEED_META_KEY, { ...marker });
}

/** Build the marker for a seed attempt. `report` is null when no seed ran. */
export function markerFromReport(report: SeedGeometryReport | null | undefined, at: string): GeometrySeedMarker {
  return {
    expected: report?.offered ?? 0,
    seeded: report?.seeded ?? 0,
    failed: report?.failed ?? 0,
    abandoned: report?.abandoned ?? false,
    at,
  };
}

/**
 * Read the marker, tolerating anything a room might actually hold: absent (a
 * room seeded before this existed), or a value written by a future/older
 * client. A malformed marker reads as absent rather than as a bogus `expected`.
 */
export function readGeometrySeedMarker(doc: SeedMetaDoc): GeometrySeedMarker | null {
  const raw = metaMapOf(doc).get(GEOMETRY_SEED_META_KEY);
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const expected = num(rec.expected);
  if (expected === null) return null;
  return {
    expected,
    seeded: num(rec.seeded) ?? 0,
    failed: num(rec.failed) ?? 0,
    abandoned: rec.abandoned === true,
    at: typeof rec.at === 'string' ? rec.at : '',
  };
}

export interface RoomGeometryState {
  /** The owner's marker, or null when the room predates it. */
  marker: GeometrySeedMarker | null;
  /** Size of the doc's `geometry` map. */
  geometryRecords: number;
  /** Meshes this joiner actually decoded. */
  hydratedMeshes: number;
}

/**
 * Joiner-facing message for a room that rendered nothing, or `null` to stay
 * silent.
 *
 * The no-marker + no-geometry-records case is deliberately silent: it is
 * genuinely indistinguishable from a legitimate structure-only share, and
 * guessing would fire on every one of them. Rooms seeded from this change on
 * carry the marker, so the case that caused the outage is covered at the
 * source as well as here.
 */
export function missingRoomGeometryMessage(state: RoomGeometryState): string | null {
  if (state.hydratedMeshes > 0) return null;
  if (state.marker) {
    if (state.marker.expected === 0) return null;
    return 'This shared model has no 3D geometry: the sender was not able to upload it. Ask them to share the link again.';
  }
  if (state.geometryRecords > 0) {
    return 'This shared model references 3D geometry that could not be downloaded. Try reloading the link.';
  }
  return null;
}
