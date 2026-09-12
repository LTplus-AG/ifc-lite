/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A clash run as a flat table — one row per clash, both elements' identities
 * on the row — for CSV / spreadsheet / BI consumption (#3944).
 *
 * This is the shape a coordinator loads into Power BI or Excel: every column is
 * a scalar, the two IfcGUIDs are bare so they JOIN back to the model's own
 * element tables, and the coordinator's review state is on the same row as the
 * detection so the export is the report, not half of one.
 *
 * Headless and pure: the viewer and the CLI both build rows here and only
 * differ in how they resolve a model NAME and a STOREY for an element (the
 * result carries a model id and no storey — `ClashElementRef` drops the
 * storey the adapter saw, and a synthetic model id is not a name a reader
 * recognises). Serialisation is `tableToCsv` from `@ifc-lite/export`.
 */
import { clashReviewKey } from '../review.js';
import {
  DEFAULT_CLASH_REVIEW_STATUS,
  type Clash,
  type ClashElementRef,
  type ClashGroup,
  type ClashReview,
  type ClashReviewStatus,
  type ClashSeverity,
  type ClashStatus,
} from '../types.js';

export interface ClashTableRow {
  /** `Clash.id` — durable within a run (two keys + rule). */
  ClashId: string;
  Rule: string;
  /** Detection classification: `hard` / `clearance` / `touch`. */
  Status: ClashStatus;
  Severity: ClashSeverity;
  /** Coordinator triage (`open` / `resolved` / `accepted`); `open` when never reviewed. */
  Review: ClashReviewStatus;
  ReviewComment: string;
  /** ISO-8601 instant of the last review edit; empty when never reviewed. */
  ReviewUpdatedAt: string;
  /** Bare IfcGUID of element A, or empty when the element has none (synthetic key). */
  GlobalIdA: string;
  GlobalIdB: string;
  /** The adapter's durable key — IfcGUID, `IfcGUID:occurrence`, `expressid:…` or a USD prim path. */
  KeyA: string;
  KeyB: string;
  ModelA: string;
  ModelB: string;
  TypeA: string;
  TypeB: string;
  NameA: string;
  NameB: string;
  StoreyA: string;
  StoreyB: string;
  /** Contact point (hard) or closest-point midpoint, in the run's world frame. */
  PointX: number;
  PointY: number;
  PointZ: number;
  /** Signed: `<0` penetration depth, `>0` gap. */
  Distance: number;
  /** `mesh` / `estimate`, or empty for a run recorded before the field existed. */
  DistanceKind: string;
  /** Title of the group this clash was clustered into, when groups were computed. */
  Group: string;
}

/** Column order, which is also the CSV header order. */
export const CLASH_TABLE_COLUMNS: ReadonlyArray<keyof ClashTableRow> = [
  'ClashId', 'Rule', 'Status', 'Severity', 'Review', 'ReviewComment', 'ReviewUpdatedAt',
  'GlobalIdA', 'GlobalIdB', 'KeyA', 'KeyB', 'ModelA', 'ModelB',
  'TypeA', 'TypeB', 'NameA', 'NameB', 'StoreyA', 'StoreyB',
  'PointX', 'PointY', 'PointZ', 'Distance', 'DistanceKind', 'Group',
];

export interface ClashTableOptions {
  /** Review state per `clashReviewKey`; a clash absent from the map is `open`. */
  reviews?: ReadonlyMap<string, ClashReview>;
  /** Storey name for an element, or empty/undefined when unknown. */
  storeyOf?: (ref: ClashElementRef) => string | undefined;
  /** Human model name for a model id; defaults to the id itself. */
  modelNameOf?: (modelId: string) => string | undefined;
  /** Groups the clashes were clustered into; fills the `Group` column. */
  groups?: readonly ClashGroup[];
}

/** An IfcGUID is exactly 22 characters of the IFC base-64 alphabet. */
const IFC_GUID_RE = /^[0-9A-Za-z_$]{22}$/;

/**
 * The bare IfcGUID behind an adapter key, or empty when the key is not one.
 *
 * The STEP adapter keys an element on its GlobalId, suffixed with
 * `:<occurrence>` for a GPU-instanced occurrence, and falls back to
 * `expressid:<model>:<n>` when the entity has no GlobalId; the IFCX adapter
 * keys on a USD prim path. Only the first form is a GUID a reader can join on,
 * so the others yield an empty cell rather than a string that LOOKS joinable.
 */
export function bareIfcGuid(key: string): string {
  const colon = key.indexOf(':');
  const candidate = colon === -1 ? key : key.slice(0, colon);
  return IFC_GUID_RE.test(candidate) ? candidate : '';
}

export function clashTableRows(
  clashes: readonly Clash[],
  options: ClashTableOptions = {},
): ClashTableRow[] {
  const { reviews, storeyOf, modelNameOf, groups } = options;
  const groupOf = new Map<string, string>();
  for (const group of groups ?? []) {
    for (const member of group.members) groupOf.set(member.id, group.title);
  }
  const modelName = (id: string): string => modelNameOf?.(id) ?? id;
  const storey = (ref: ClashElementRef): string => storeyOf?.(ref) ?? '';

  return clashes.map((clash) => {
    const review = reviews?.get(clashReviewKey(clash));
    return {
      ClashId: clash.id,
      Rule: clash.rule,
      Status: clash.status,
      Severity: clash.severity,
      Review: review?.status ?? DEFAULT_CLASH_REVIEW_STATUS,
      ReviewComment: review?.comment ?? '',
      ReviewUpdatedAt: review?.updatedAt != null ? new Date(review.updatedAt).toISOString() : '',
      GlobalIdA: bareIfcGuid(clash.a.key),
      GlobalIdB: bareIfcGuid(clash.b.key),
      KeyA: clash.a.key,
      KeyB: clash.b.key,
      ModelA: modelName(clash.a.model),
      ModelB: modelName(clash.b.model),
      TypeA: clash.a.tag,
      TypeB: clash.b.tag,
      NameA: clash.a.name ?? '',
      NameB: clash.b.name ?? '',
      StoreyA: storey(clash.a),
      StoreyB: storey(clash.b),
      PointX: clash.point[0],
      PointY: clash.point[1],
      PointZ: clash.point[2],
      Distance: clash.distance,
      DistanceKind: clash.distanceKind ?? '',
      Group: groupOf.get(clash.id) ?? '',
    };
  });
}
