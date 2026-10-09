/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Portable saved clash report contract and boundary validation (#6947). No
 * model, store or other runtime imports: the saved content library and a
 * backup import both validate through `isSavedClashReport`, which loads on
 * demand (`saved-report-persistence`).
 *
 * A report is frozen evidence of one run. It keeps no renderer ids, so nothing
 * in it can be resolved against whatever model happens to be loaded later:
 * elements are named by their durable key (IfcGUID, with the occurrence suffix
 * the engine adds for instanced geometry) and by the model they were found in,
 * and each model by its name plus the source identities the viewer had for it.
 * Model name plus GlobalId is the element identity the coordination review
 * (#6922) validates findings with, and `rule` plus the two keys is what
 * `clashReviewKey` builds its lineage from, so a saved report can become a
 * historical run there without a schema change.
 */

import type { ClashDistanceKind, ClashMode, ClashReviewStatus, ClashSeverity, ClashStatus } from '@ifc-lite/clash';

/** One model the run drew elements from. `id` is the per-load id the rows refer to; it is a join key inside this report, never a live model id. */
export interface SavedClashModel {
  id: string;
  name: string;
  /** Sampled source fingerprint (`FederatedModel.sourceFingerprint`), when the viewer had one. */
  sourceFingerprint?: string;
  /** Full-content source hash (`FederatedModel.sourceContentHash`), when the viewer had one. */
  sourceContentHash?: string;
}

/** A rule as the run executed it. An explicit member list is a set of per-load ids, so a report keeps only the fact
 * that a side was chosen that way (`fromMembersA` / `fromMembersB`) and how many elements it matched. */
export interface SavedClashRule {
  id: string;
  name: string;
  a: string;
  b?: string;
  mode: ClashMode;
  tolerance?: number;
  clearance?: number;
  severity?: ClashSeverity;
  reportTouch?: boolean;
  fromMembersA?: boolean;
  fromMembersB?: boolean;
  /** Elements the rule matched on each side (`matchedB` is null for a self-clash), when the engine reported coverage. */
  matchedA?: number;
  matchedB?: number | null;
}

export interface SavedClashElement {
  /** Durable element key from the engine (`ClashElementRef.key`). */
  key: string;
  /** `SavedClashModel.id` of the model the element was found in. */
  model: string;
  /** IFC class. */
  tag: string;
  name?: string;
}

/** One clash with the review and group it had when the report was saved. */
export interface SavedClash {
  id: string;
  rule: string;
  status: ClashStatus;
  severity: ClashSeverity;
  /** Signed distance in metres; null when the engine reported no finite value. */
  distance: number | null;
  distanceKind?: ClashDistanceKind;
  a: SavedClashElement;
  b: SavedClashElement;
  /** Storey name of element A when saved; empty when it had none. */
  storey: string;
  review: ClashReviewStatus;
  comment?: string;
  /** Group title when saved; empty when ungrouped. */
  group: string;
}

export interface SavedClashCompleteness {
  /** The engine dropped candidate pairs at its cap; the result is not the whole population. */
  truncated?: { reason: string; droppedPairs: number };
  /** The models were edited or moved after the run and before it was saved. */
  stale: boolean;
  /** Clashes the user's enabled exclusion rules were hiding when the report was saved. */
  excluded: number;
}

export interface SavedClashReport {
  version: 1;
  id: string;
  name: string;
  savedAt: string;
  run: {
    settings: { tolerance: number; excludeVoidsAndHosts: boolean };
    rules: SavedClashRule[];
    /** Viewer edit counter when the run finished; above zero the models differed from their source files. */
    mutationRevision?: number;
  };
  models: SavedClashModel[];
  completeness: SavedClashCompleteness;
  /** Which grouping the `group` titles came from. */
  grouping: 'derived' | 'manual' | null;
  clashes: SavedClash[];
}

export const CLASH_REPORT_LIMITS = { clashes: 100_000, rules: 2_000, models: 1_000, text: 2_000, name: 200 } as const;

// Each list is checked against its union at compile time: a value the engine adds must be added here, and none can be misspelt.
const values = <T extends string>(all: Record<T, true>): readonly T[] => Object.keys(all) as T[];
const STATUSES = values<ClashStatus>({ hard: true, clearance: true, touch: true });
const SEVERITIES = values<ClashSeverity>({ critical: true, major: true, minor: true, info: true });
const MODES = values<ClashMode>({ hard: true, clearance: true });
const DISTANCE_KINDS = values<ClashDistanceKind>({ mesh: true, estimate: true });
const REVIEWS = values<ClashReviewStatus>({ open: true, resolved: true, accepted: true });

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, allowEmpty = false, max: number = CLASH_REPORT_LIMITS.text): v is string =>
  typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0);
const optionalText = (v: unknown): boolean => v === undefined || text(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const optional = (v: unknown, check: (value: unknown) => boolean): boolean => v === undefined || check(v);
const isBoolean = (v: unknown): boolean => typeof v === 'boolean';
const oneOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);

function isModel(v: unknown): v is SavedClashModel {
  return record(v) && text(v.id) && text(v.name) && v.name.trim().length > 0 && optionalText(v.sourceFingerprint) && optionalText(v.sourceContentHash);
}

function isRule(v: unknown): v is SavedClashRule {
  return record(v) && text(v.id) && text(v.name, true) && text(v.a, true) && optional(v.b, (b) => text(b, true)) && oneOf(v.mode, MODES)
    && optional(v.tolerance, finite) && optional(v.clearance, finite) && optional(v.severity, (s) => oneOf(s, SEVERITIES))
    && optional(v.reportTouch, isBoolean) && optional(v.fromMembersA, isBoolean) && optional(v.fromMembersB, isBoolean)
    && optional(v.matchedA, count) && optional(v.matchedB, (m) => m === null || count(m));
}

function isElement(v: unknown, models: ReadonlySet<string>): v is SavedClashElement {
  return record(v) && text(v.key) && text(v.model) && models.has(v.model) && text(v.tag, true) && optional(v.name, (n) => text(n, true));
}

function isClash(v: unknown, models: ReadonlySet<string>): v is SavedClash {
  return record(v) && text(v.id) && text(v.rule) && oneOf(v.status, STATUSES) && oneOf(v.severity, SEVERITIES)
    && (v.distance === null || finite(v.distance)) && optional(v.distanceKind, (k) => oneOf(k, DISTANCE_KINDS))
    && isElement(v.a, models) && isElement(v.b, models) && text(v.storey, true) && oneOf(v.review, REVIEWS)
    && optional(v.comment, (c) => text(c, true, 16_384)) && text(v.group, true);
}

/** Strict: one invalid row refuses the whole report rather than charting a subset of a run as if it were the run. */
export function isSavedClashReport(v: unknown): v is SavedClashReport {
  if (!record(v) || v.version !== 1 || !text(v.id) || !text(v.name, false, CLASH_REPORT_LIMITS.name) || !v.name.trim()) return false;
  if (typeof v.savedAt !== 'string' || !Number.isFinite(Date.parse(v.savedAt))) return false;
  const run = v.run;
  if (!record(run) || !record(run.settings) || !finite(run.settings.tolerance) || typeof run.settings.excludeVoidsAndHosts !== 'boolean') return false;
  if (!Array.isArray(run.rules) || run.rules.length > CLASH_REPORT_LIMITS.rules || !run.rules.every(isRule) || !optional(run.mutationRevision, count)) return false;
  if (!Array.isArray(v.models) || v.models.length > CLASH_REPORT_LIMITS.models || !v.models.every(isModel)) return false;
  const models = new Set(v.models.map((model: SavedClashModel) => model.id));
  if (models.size !== v.models.length) return false;
  const completeness = v.completeness;
  if (!record(completeness) || typeof completeness.stale !== 'boolean' || !count(completeness.excluded)) return false;
  if (completeness.truncated !== undefined && (!record(completeness.truncated) || !text(completeness.truncated.reason, true) || !finite(completeness.truncated.droppedPairs) || completeness.truncated.droppedPairs < 0)) return false;
  if (v.grouping !== null && v.grouping !== 'derived' && v.grouping !== 'manual') return false;
  return Array.isArray(v.clashes) && v.clashes.length <= CLASH_REPORT_LIMITS.clashes && v.clashes.every((clash) => isClash(clash, models));
}
