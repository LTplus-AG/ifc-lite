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
  /**
   * The seed threw before it could count what it had, so `expected` says
   * nothing. Distinct from `expected: 0`, which is a positive assertion that
   * there was nothing to seed: recording an interrupted seed as `expected: 0`
   * would tell every joiner to stay quiet about a room that is missing its
   * model.
   */
  interrupted: boolean;
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
 *
 * `skipped.empty` counts as a partial share, not a clean one: those are meshes
 * the model HAS and the room does not get, and on a large model in
 * bounded-geometry mode there can be a lot of them. `skipped.noPath` and
 * `skipped.noEntity` are deliberately NOT counted here. They are structural
 * mismatches with no established baseline in a normal share, and promoting an
 * unknown-frequency condition to a user-facing warning is how an alarm starts
 * crying wolf. Both stay in the report and in the console warning, so
 * promoting them later is a one-line change once someone has the numbers.
 */
export function classifySeed(report: SeedGeometryReport | null | undefined): SeedOutcome {
  if (!report || report.offered === 0) return 'nothing-to-seed';
  if (report.seeded === 0) return 'failed';
  // `seeded < attempted` is deliberately NOT tested here: it is implied.
  //
  // Every job that runs either records a ref (`seeded`) or increments `failed`,
  // and the breaker can leave later jobs unprocessed, so the invariant is
  // `seeded + failed <= attempted` (equality only when nothing was abandoned).
  // Not `===`: an earlier version of this comment said so and was wrong in
  // exactly the abandoned case it went on to mention.
  //
  // The conclusion survives the correction, in both directions:
  //   failed > 0  -> seeded <= attempted - failed < attempted.
  //   failed == 0 -> nothing was abandoned (the breaker only fires once
  //                  `failed` reaches `maxFailures`, which is >= 1), so every
  //                  job ran and seeded === attempted.
  // So `seeded < attempted` holds exactly when `failed > 0` does.
  //
  // It used to be here as a third term, and mutation testing is what exposed
  // it: dropping EITHER `failed > 0` or `seeded < attempted` left the suite
  // green, because each stood in for the other and the one test covering them
  // varied both at once. Two terms that always agree cannot be told apart by a
  // fixture that moves them together - so one of them was never doing anything.
  if (report.failed > 0 || report.skipped.empty > 0) {
    return 'partial';
  }
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
    const missing = report.offered - report.seeded;
    if (report.failed > 0) {
      return `Shared, but ${report.failed} of ${report.attempted} geometry uploads failed. People joining this link will be missing some elements.`;
    }
    return `Shared, but ${missing} of ${report.offered} elements could not be sent (their geometry is no longer in memory). People joining this link will be missing them.`;
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
    interrupted: false,
    at,
  };
}

/**
 * Marker for a seed that threw before it produced a report. `expected` is
 * unknown, so it is recorded as interrupted rather than as zero.
 */
export function interruptedSeedMarker(at: string): GeometrySeedMarker {
  return { expected: 0, seeded: 0, failed: 0, abandoned: false, interrupted: true, at };
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
    interrupted: rec.interrupted === true,
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
    // An interrupted seed never learned how much geometry it had, so its
    // `expected: 0` is not the "nothing to seed" assertion and must not buy
    // the silence that one does.
    if (state.marker.expected === 0 && !state.marker.interrupted) return null;
    return 'This shared model has no 3D geometry: the sender was not able to upload it. Ask them to share the link again.';
  }
  if (state.geometryRecords > 0) {
    return 'This shared model references 3D geometry that could not be downloaded. Try reloading the link.';
  }
  return null;
}
