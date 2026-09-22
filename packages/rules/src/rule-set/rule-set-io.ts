/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parse/validate/serialize a `<name>.rules.json` file (#5138 plan §3).
 *
 * `parseRuleSetFile` never throws on bad input — every failure comes back
 * as `{ ok: false, error }`, the same posture `delivery-recipe.ts` and the
 * clash-preset loader use for a saved-definition file a human can hand-edit.
 * Forward compat is deliberately asymmetric: an unknown TOP-LEVEL key or a
 * `version` newer than this build rejects the whole file (we cannot know
 * what a newer version's semantics are), while an unknown OPTIONAL field
 * nested inside an `InformationRule`/`RuleBlock` is additive by design and
 * is dropped with exactly one `console.warn` for the whole parse, not one
 * per occurrence — a rule set can carry dozens of rules and warning once
 * per field would drown the one thing worth telling the author.
 *
 * `Subject` parsing lives in `rule-set-io-subject.ts` and
 * `RuleBlock`/`Requirement` parsing in `rule-set-io-requirement.ts` — split
 * out to stay under the module-size cap; this file owns the top-level
 * `RuleSetFile` shape plus parse/serialize. `exportRuleSet`/`importRuleSetFile`
 * (DOM: `downloadFile`, `FileReader`) are NOT here — #5138 PR 7a moved the
 * rest of this module into `@ifc-lite/rules`, but those two stayed in the
 * viewer as `apps/viewer/src/lib/validation/rule-set-io-browser.ts`, which
 * calls back into `parseRuleSetFile`/`serializeRuleSet` below.
 */

import type { RuleSetFile, RuleSetTargets, InformationRule } from './rule-set.js';
import { RULE_SET_VERSION } from './rule-set.js';
import { fail, isPlainObject, isStringArray, unknownKeysOf, warnUnknownFields, resetWarnBudget, RuleSetError } from './rule-set-io-shared.js';
import { parseRuleBlock, parseRequirement } from './rule-set-io-requirement.js';

export type RuleSetParseResult =
  | { ok: true; file: RuleSetFile }
  | { ok: false; error: string };

const SEVERITIES = new Set(['error', 'warning']);

// ── targets ──────────────────────────────────────────────────────────────────

function parseTargets(raw: unknown): RuleSetTargets | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail('"targets" must be an object');
  const t = raw as Record<string, unknown>;
  const out: RuleSetTargets = {};
  // Opaque strings only — never resolved to a runtime model id here. A
  // fingerprint/tag id that no longer matches anything is the run-time
  // engine's problem (it matches nothing), not a load-time error.
  if ('modelFingerprints' in t) {
    if (!isStringArray(t.modelFingerprints)) fail('"targets.modelFingerprints" must be an array of strings');
    out.modelFingerprints = t.modelFingerprints;
  }
  if ('modelTagIds' in t) {
    if (!isStringArray(t.modelTagIds)) fail('"targets.modelTagIds" must be an array of strings');
    out.modelTagIds = t.modelTagIds;
  }
  return out;
}

// ── information rule ─────────────────────────────────────────────────────────

const INFORMATION_RULE_FIELDS = [
  'id', 'name', 'description', 'severity', 'applicability', 'requirement',
  'cardinality', 'caseSensitive', 'tolerance',
];

function parseInformationRule(raw: unknown, index: number): InformationRule {
  const where = `rules[${index}]`;
  if (!isPlainObject(raw)) fail(`${where}: must be an object`);
  const r = raw as Record<string, unknown>;

  // Legacy shape (pre-#5138 draft carried a `requirements: RuleBlock`
  // singular field, later renamed/generalised to `requirement: Requirement`).
  // No silent migration — the semantics changed (a bare block vs. the
  // kind-tagged union), so a caller must re-author, not get a guessed
  // conversion.
  if ('requirements' in r && !('requirement' in r)) {
    fail(`${where}: found legacy "requirements" field — renamed to "requirement" (#5138), no automatic migration`);
  }

  if (typeof r.id !== 'string' || r.id.length === 0) fail(`${where}: "id" is required`);
  if (typeof r.name !== 'string' || r.name.length === 0) fail(`${where}: "name" is required`);
  if (r.description !== undefined && typeof r.description !== 'string') fail(`${where}: "description" must be a string`);
  if (r.severity !== undefined && !SEVERITIES.has(r.severity as string)) fail(`${where}: bad "severity"`);
  if (r.caseSensitive !== undefined && typeof r.caseSensitive !== 'boolean') fail(`${where}: "caseSensitive" must be a boolean`);

  let tolerance: number | undefined;
  if (r.tolerance !== undefined) {
    if (typeof r.tolerance !== 'number' || !Number.isFinite(r.tolerance)) fail(`${where}: "tolerance" must be a finite number`);
    tolerance = Math.max(0, r.tolerance);
  }

  let cardinality: InformationRule['cardinality'];
  if (r.cardinality !== undefined) {
    if (!isPlainObject(r.cardinality)) fail(`${where}.cardinality: must be an object`);
    const c = r.cardinality as Record<string, unknown>;
    cardinality = {};
    if (c.minApplicable !== undefined) {
      if (typeof c.minApplicable !== 'number' || !Number.isFinite(c.minApplicable)) fail(`${where}.cardinality: "minApplicable" must be a finite number`);
      cardinality.minApplicable = Math.max(0, c.minApplicable);
    }
    if (c.maxApplicable !== undefined) {
      if (typeof c.maxApplicable !== 'number' || !Number.isFinite(c.maxApplicable)) fail(`${where}.cardinality: "maxApplicable" must be a finite number`);
      cardinality.maxApplicable = Math.max(0, c.maxApplicable);
    }
  }

  const applicability = parseRuleBlock(r.applicability, `${where}.applicability`, null);
  const requirement = parseRequirement(r.requirement, `${where}.requirement`);

  warnUnknownFields(where, unknownKeysOf(r, INFORMATION_RULE_FIELDS));

  return {
    id: r.id, name: r.name,
    ...(r.description !== undefined ? { description: r.description as string } : {}),
    ...(r.severity !== undefined ? { severity: r.severity as InformationRule['severity'] } : {}),
    applicability, requirement,
    ...(cardinality ? { cardinality } : {}),
    ...(r.caseSensitive !== undefined ? { caseSensitive: r.caseSensitive as boolean } : {}),
    ...(tolerance !== undefined ? { tolerance } : {}),
  };
}

// ── top level ────────────────────────────────────────────────────────────────

const RULE_SET_FIELDS = ['version', 'name', 'description', 'targets', 'rules'];

/** Parse/validate an unknown JSON value into a `RuleSetFile`. Never throws —
 *  every rejection reason (unknown top-level key, a version this build does
 *  not understand, a malformed rule) comes back as `error`. */
export function parseRuleSetFile(raw: unknown): RuleSetParseResult {
  resetWarnBudget();
  try {
    if (!isPlainObject(raw)) fail('a rule set file must be a JSON object');
    const obj = raw as Record<string, unknown>;

    const unknownTop = unknownKeysOf(obj, RULE_SET_FIELDS);
    if (unknownTop.length > 0) fail(`unrecognised top-level field(s): ${unknownTop.join(', ')}`);

    if (typeof obj.version !== 'number') fail('"version" must be a number');
    if (obj.version > RULE_SET_VERSION) {
      fail(`this file was created by a newer rule-set format (version ${obj.version}); this build only understands version ${RULE_SET_VERSION}`);
    }
    if (obj.version !== RULE_SET_VERSION) fail(`unsupported "version" ${obj.version}, expected ${RULE_SET_VERSION}`);

    if (typeof obj.name !== 'string' || obj.name.length === 0) fail('"name" is required');
    if (obj.description !== undefined && typeof obj.description !== 'string') fail('"description" must be a string');

    const targets = parseTargets(obj.targets);

    if (!Array.isArray(obj.rules)) fail('"rules" must be an array');
    const rules = obj.rules.map((r, i) => parseInformationRule(r, i));

    const file: RuleSetFile = {
      version: RULE_SET_VERSION,
      name: obj.name,
      ...(obj.description !== undefined ? { description: obj.description as string } : {}),
      ...(targets ? { targets } : {}),
      rules,
    };
    return { ok: true, file };
  } catch (err) {
    if (err instanceof RuleSetError) return { ok: false, error: err.message };
    return { ok: false, error: `Failed to parse rule set: ${(err as Error).message}` };
  }
}

export function serializeRuleSet(file: RuleSetFile): string {
  return JSON.stringify(file, null, 2);
}
