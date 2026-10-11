/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Portable contract for a captured clash or validation run kept for
 * cross-revision reconciliation (#7370). No store or runtime imports: the
 * content library, a backup import and recovery all validate through
 * `decodeSavedAnalysisRun`.
 *
 * A session capture (`CapturedRun`) is the native result object, which names
 * the session's model ids and, for clashes, renderer ids. Neither means
 * anything after a reload. A saved run therefore keeps the native result with
 * every model id replaced by a join key (`SavedRunModel.key`), each model by
 * its name and the source identities the viewer had for it, and each clash
 * element by its local express id instead of the renderer id. An element
 * without a GlobalId has a model-scoped key (`expressid:<model>:<id>`); its
 * model part is the join key too. Everything the
 * reconciler compares (rules, settings, coverage, truncation, specifications,
 * rule content, per-entity results) is kept as the native run recorded it, so
 * the same compatibility checks and refusals apply to a reopened run.
 */

import type { Clash, ClashElementRef, ClashResult } from '@ifc-lite/clash';
import type { EntityResult, SetResult, SpecificationResult, ValidationModelInfo, ValidationReport } from '@ifc-lite/ids';

export type SavedTranslation = [number, number, number];

/** One model the run drew from. `key` joins the rows of this payload; it is never a live model id. */
export interface SavedRunModel {
  key: string;
  name: string;
  /** Sampled source fingerprint (`FederatedModel.sourceFingerprint`), when the viewer had one. */
  sourceFingerprint?: string;
  /** Full-content source hash (`FederatedModel.sourceContentHash`), when the viewer had one. */
  sourceContentHash?: string;
  /** Placement the run was stamped with; absent when the run recorded none. */
  placement?: { translation: SavedTranslation; angle: number; pivot: SavedTranslation };
}

/** A clash element named by its local express id; the renderer id is rebuilt from the bound model. */
export type SavedClashRef = Omit<ClashElementRef, 'ref'> & { expressId: number };
/** A non-finite distance survives as its name: JSON would turn it into null. */
export type SavedDistance = number | 'Infinity' | '-Infinity' | 'NaN';
export type SavedRunClash = Omit<Clash, 'a' | 'b' | 'distance'> & { a: SavedClashRef; b: SavedClashRef; distance: SavedDistance };
export type SavedRunClashResult = Omit<ClashResult, 'clashes'> & { clashes: SavedRunClash[] };

export type SavedRunValidationReport = Omit<ValidationReport, 'timestamp'> & { timestamp: string };
/** The rule content a rules report ran from (`ReportRuleSetContent`), as rule id/text pairs. */
export interface SavedRuleSetContent { file: string; rules: Array<[string, string]> }

interface SavedAnalysisRunBase {
  version: 1;
  /** The session capture id, kept so a reopened run is the same run to reconciliation and Review. */
  id: string;
  capturedAt: string;
  savedAt: string;
  models: SavedRunModel[];
  /** Keys of the models the run examined; null when the run did not record them. */
  examined: string[] | null;
  /** When saved: the run described the open models, they changed after it, or the run carried no freshness stamp. */
  freshness: 'current' | 'stale' | 'unknown';
  /** A model the run examined had unsaved edits when it ran, so the run does not describe its file; null when unknown. */
  edited: boolean | null;
  /** The run's stamp recorded each model's placement (clash runs do). */
  placementRecorded: boolean;
  /**
   * The placement frame of a placement-stamped run, exactly what makes such a run stale in its session:
   * the committed realignment (`realignedFrameKey`), how many models were open, and each open model the run
   * did not examine (`others`, with its source identity and placement). Null without placement.
   */
  frame: { realignedFrameKey: string | null; openModels: number; others: SavedRunModel[] } | null;
}

export type SavedAnalysisRun =
  | SavedAnalysisRunBase & { kind: 'clash'; result: SavedRunClashResult }
  | SavedAnalysisRunBase & { kind: 'validation'; report: SavedRunValidationReport; ruleSet: SavedRuleSetContent | null };

export const SAVED_RUN_LIMITS = { models: 1_000, clashes: 200_000, rules: 2_000, specifications: 5_000, text: 2_000 } as const;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, allowEmpty = false, max: number = SAVED_RUN_LIMITS.text): v is string =>
  typeof v === 'string' && v.length <= max && (allowEmpty || v.length > 0);
const anyText = (v: unknown): v is string => typeof v === 'string';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const optional = (v: unknown, check: (value: unknown) => boolean): boolean => v === undefined || check(v);
const bool = (v: unknown): v is boolean => typeof v === 'boolean';
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const list = (v: unknown, max: number, check: (value: unknown) => boolean): v is unknown[] =>
  Array.isArray(v) && v.length <= max && v.every(check);
const oneOf = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v);
const vector = (v: unknown): v is SavedTranslation => Array.isArray(v) && v.length === 3 && v.every(finite);

function isModel(v: unknown): v is SavedRunModel {
  return record(v) && text(v.key) && text(v.name) && optional(v.sourceFingerprint, text) && optional(v.sourceContentHash, text)
    && optional(v.placement, p => record(p) && vector(p.translation) && finite(p.angle) && vector(p.pivot));
}

function isClashRef(v: unknown, keys: ReadonlySet<string>): boolean {
  return record(v) && text(v.key) && text(v.model) && keys.has(v.model) && anyText(v.tag) && optional(v.name, anyText) && count(v.expressId);
}

const DISTANCE_NAMES = ['Infinity', '-Infinity', 'NaN'];
function isClash(v: unknown, keys: ReadonlySet<string>): boolean {
  return record(v) && text(v.id) && text(v.rule) && oneOf(v.status, ['hard', 'clearance', 'touch'])
    && oneOf(v.severity, ['critical', 'major', 'minor', 'info']) && (finite(v.distance) || oneOf(v.distance, DISTANCE_NAMES))
    && optional(v.distanceKind, k => oneOf(k, ['mesh', 'estimate'])) && optional(v.depthFloor, finite)
    && vector(v.point) && record(v.bounds) && vector(v.bounds.min) && vector(v.bounds.max)
    && isClashRef(v.a, keys) && isClashRef(v.b, keys);
}

const keyList = (v: unknown) => Array.isArray(v) && v.every(anyText);
function isCoverage(v: unknown): boolean {
  return record(v) && text(v.rule) && count(v.matchedA) && (v.matchedB === null || count(v.matchedB))
    && optional(v.fromMembersA, bool) && optional(v.fromMembersB, bool) && optional(v.matchedKeysA, keyList)
    && optional(v.matchedKeysB, k => k === null || keyList(k)) && optional(v.candidatesExamined, count);
}

function isRule(v: unknown): boolean {
  // Member lists name session renderer ids; a saved run never carries them.
  return record(v) && text(v.id) && anyText(v.name) && anyText(v.a) && optional(v.b, anyText) && oneOf(v.mode, ['hard', 'clearance'])
    && optional(v.tolerance, finite) && optional(v.clearance, finite)
    && optional(v.severity, s => oneOf(s, ['critical', 'major', 'minor', 'info'])) && optional(v.reportTouch, bool)
    && v.membersA === undefined && v.membersB === undefined;
}

function isClashResult(v: unknown, keys: ReadonlySet<string>): v is SavedRunClashResult {
  if (!record(v) || !record(v.settings) || !finite(v.settings.tolerance) || !bool(v.settings.excludeVoidsAndHosts)) return false;
  if (!record(v.summary) || !list(v.rulesRun, SAVED_RUN_LIMITS.rules, isRule)) return false;
  if (!optional(v.ruleCoverage, c => list(c, SAVED_RUN_LIMITS.rules, isCoverage))) return false;
  if (!optional(v.truncated, t => record(t) && anyText(t.reason) && count(t.droppedPairs))) return false;
  return list(v.clashes, SAVED_RUN_LIMITS.clashes, clash => isClash(clash, keys));
}

function isEntity(v: unknown, keys: ReadonlySet<string>): v is EntityResult {
  return record(v) && count(v.expressId) && text(v.modelId) && keys.has(v.modelId) && anyText(v.entityType)
    && optional(v.entityName, anyText) && optional(v.globalId, anyText) && bool(v.passed)
    && Array.isArray(v.requirementResults) && v.requirementResults.every(r => record(r) && record(r.requirement)
      && anyText(r.requirement.id) && oneOf(r.status, ['pass', 'fail', 'not_applicable']) && optional(r.actualValue, anyText));
}

function isSetResult(v: unknown, keys: ReadonlySet<string>): v is SetResult {
  return record(v) && Array.isArray(v.members) && v.members.every(m => record(m) && text(m.modelId) && keys.has(m.modelId) && count(m.expressId));
}

function isSpecification(v: unknown, keys: ReadonlySet<string>): v is SpecificationResult {
  return record(v) && record(v.specification) && anyText(v.specification.id) && anyText(v.specification.name)
    && oneOf(v.status, ['pass', 'fail', 'not_applicable']) && count(v.applicableCount) && count(v.passedCount) && count(v.failedCount)
    && optional(v.error, anyText) && Array.isArray(v.entityResults) && v.entityResults.every(e => isEntity(e, keys))
    && optional(v.setResults, s => Array.isArray(s) && s.every(r => isSetResult(r, keys)));
}

function isModelInfo(v: unknown, keys: ReadonlySet<string>): v is ValidationModelInfo {
  return record(v) && text(v.modelId) && keys.has(v.modelId) && anyText(v.schemaVersion) && count(v.entityCount);
}

function isValidationReport(v: unknown, keys: ReadonlySet<string>): v is SavedRunValidationReport {
  if (!record(v) || !date(v.timestamp) || !record(v.summary) || !record(v.source)) return false;
  const source = v.source;
  if (!(source.kind === 'ids' && record(source.document) && Array.isArray(source.document.specifications))
    && !(source.kind === 'rules' && record(source.ruleSet) && anyText(source.ruleSet.name))) return false;
  return list(v.modelInfo, SAVED_RUN_LIMITS.models, info => isModelInfo(info, keys))
    && list(v.specificationResults, SAVED_RUN_LIMITS.specifications, spec => isSpecification(spec, keys));
}

function isRuleSet(v: unknown): v is SavedRuleSetContent {
  return record(v) && anyText(v.file) && Array.isArray(v.rules)
    && v.rules.every(entry => Array.isArray(entry) && entry.length === 2 && anyText(entry[0]) && anyText(entry[1]));
}

const isFrame = (v: unknown): v is NonNullable<SavedAnalysisRunBase['frame']> => record(v)
  && (v.realignedFrameKey === null || text(v.realignedFrameKey)) && count(v.openModels) && v.openModels > 0
  && list(v.others, SAVED_RUN_LIMITS.models, other => isModel(other) && other.placement !== undefined);

/** Strict: one invalid row refuses the whole run rather than reconciling a subset of it as if it were the run. */
export function decodeSavedAnalysisRun(v: unknown): SavedAnalysisRun | null {
  if (!record(v) || v.version !== 1 || !text(v.id, false, 200) || !date(v.capturedAt) || !date(v.savedAt)) return null;
  if (!oneOf(v.freshness, ['current', 'stale', 'unknown']) || !(v.edited === null || bool(v.edited)) || !bool(v.placementRecorded)) return null;
  if (v.placementRecorded ? !isFrame(v.frame) : v.frame !== null) return null;
  if (!list(v.models, SAVED_RUN_LIMITS.models, isModel)) return null;
  const keys = new Set((v.models as SavedRunModel[]).map(model => model.key));
  if (keys.size !== v.models.length) return null;
  // A frame model is one the run did not examine: its key never names a run model, and no two share one.
  const others = isFrame(v.frame) ? v.frame.others : [];
  if (new Set([...keys, ...others.map(other => other.key)]).size !== keys.size + others.length) return null;
  if (v.examined !== null && !list(v.examined, SAVED_RUN_LIMITS.models, key => typeof key === 'string' && keys.has(key))) return null;
  if (v.kind === 'clash') return isClashResult(v.result, keys) ? v as unknown as SavedAnalysisRun : null;
  if (v.kind === 'validation') {
    return isValidationReport(v.report, keys) && (v.ruleSet === null || isRuleSet(v.ruleSet)) ? v as unknown as SavedAnalysisRun : null;
  }
  return null;
}
