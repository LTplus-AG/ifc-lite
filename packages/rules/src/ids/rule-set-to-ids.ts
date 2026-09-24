/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export a rule set as an IDS 1.0 document (#5225), for the subset IDS can
 * express. Every rule either becomes one specification that checks the
 * same thing, or is refused with each reason named. Nothing is dropped or
 * approximated silently: a rule-level setting IDS has no room for (a
 * warning severity, a custom tolerance, case-insensitive matching) is a
 * refusal too, because the exported check would give a different verdict.
 *
 * Refused outright: `unique`, `aggregate` and `compare` requirements,
 * negated operators, OR (across groups or inside one), `ifcType` without
 * `exactClass`, `caseSensitive: false`, and model / model-tag targeting.
 * The per-condition mapping is in `rule-to-ids-facets.ts`.
 */

import type { IDSDocument, IDSRequirement, IDSSpecification, IFCVersion } from '@ifc-lite/ids';
import type { InformationRule, RuleSetFile } from '../rule-set/rule-set.js';
import { groupToFacets, type StoredUnitScaleOf } from './rule-to-ids-facets.js';
import { storedUnitScaleOf } from './stored-unit-scale.js';
import type { EvaluatorModel } from '../filter/filter-evaluate.js';
import { writeIdsXml } from './ids-xml-writer.js';

/** The engine's default relative tolerance, which IDS 1.0 also fixes (bSI #418). */
const IDS_TOLERANCE = 1e-6;

export interface RuleSetToIdsOptions {
  /** `ifcVersion` of every specification. Default: `['IFC4']`. */
  ifcVersions?: IFCVersion[];
  /**
   * The models the rule set runs on. A numeric property or quantity check
   * compared in model units is exported in SI, converted with the unit
   * these models store that value in (#5225). Without models, or when they
   * disagree, such a rule is refused with the reason; a rule already
   * compared in SI (`valueUnit: 'si'`) exports without them.
   */
  models?: ReadonlyArray<EvaluatorModel>;
}

export interface RefusedRule {
  ruleId: string;
  ruleName: string;
  reasons: string[];
}

export interface RuleSetToIdsResult {
  /** `null` when no rule could be exported (an IDS needs a specification). */
  xml: string | null;
  document: IDSDocument;
  exportedRuleIds: string[];
  refused: RefusedRule[];
  /** Caveats that apply to the exported specifications as a whole. */
  notes: string[];
}

/** Literal set/property names match case-insensitively in the rule engine, case-sensitively in IDS. */
const NAME_CASE_NOTE =
  'Property set and property names are matched case-sensitively by IDS; the rule engine matches literal names case-insensitively';

type SpecOutcome =
  | { ok: true; spec: IDSSpecification; notes: string[] }
  | { ok: false; reasons: string[] };

function cardinalityOf(rule: InformationRule, reasons: string[]): Pick<IDSSpecification, 'minOccurs' | 'maxOccurs'> {
  const min = rule.cardinality?.minApplicable;
  const max = rule.cardinality?.maxApplicable;
  if (min === undefined && max === undefined) return { minOccurs: 0, maxOccurs: 'unbounded' };
  if (max === 0 && (min === undefined || min === 0)) return { minOccurs: 0, maxOccurs: 0 };
  if (max === undefined && (min === 0 || min === 1)) return { minOccurs: min, maxOccurs: 'unbounded' };
  reasons.push(
    `the applicable-count bounds (min ${min ?? 0}, max ${max ?? 'unbounded'}) have no IDS 1.0 form, ` +
    'which only knows required (at least one), optional and prohibited (none)',
  );
  return {};
}

/** Why each requirement kind other than `element` has no IDS form. */
const NON_ELEMENT_REASON: Record<Exclude<InformationRule['requirement']['kind'], 'element'>, string> = {
  unique: 'a "unique" requirement compares values across elements; IDS checks one element at a time',
  aggregate: 'an "aggregate" requirement totals values across elements; IDS checks one element at a time',
  compare: 'a "compare" requirement compares two values of one element; IDS only compares a value with a fixed one',
  unit: 'a "unit" requirement checks the unit a value is recorded in, which IDS 1.0 cannot state',
};

function ruleToSpecification(rule: InformationRule, ifcVersions: IFCVersion[], scaleOf: StoredUnitScaleOf | undefined): SpecOutcome {
  const reasons: string[] = [];
  const notes: string[] = [];

  if (rule.requirement.kind !== 'element') {
    reasons.push(NON_ELEMENT_REASON[rule.requirement.kind]);
  }
  if (rule.severity === 'warning') {
    reasons.push('IDS has no warning severity: every failed specification is an error');
  }
  if (rule.caseSensitive === false) {
    reasons.push('case-insensitive matching (caseSensitive: false) cannot be expressed in IDS, which is case-sensitive');
  }
  if (rule.tolerance !== undefined && rule.tolerance !== IDS_TOLERANCE) {
    reasons.push(`a numeric tolerance of ${rule.tolerance} differs from the 1e-6 IDS fixes`);
  }
  const cardinality = cardinalityOf(rule, reasons);

  const applicabilityGroups = rule.applicability.groups;
  let applicabilityFacets: IDSSpecification['applicability']['facets'] = [];
  if (applicabilityGroups.length !== 1) {
    reasons.push(applicabilityGroups.length === 0
      ? 'the applicability is empty'
      : 'applicability groups combined with OR cannot be expressed in one IDS specification');
  } else {
    const mapped = groupToFacets(applicabilityGroups[0], 'applicability', scaleOf);
    if (mapped.ok) { applicabilityFacets = mapped.facets; notes.push(...mapped.notes); }
    else reasons.push(...mapped.reasons.map((r) => `applicability: ${r}`));
  }

  const requirements: IDSRequirement[] = [];
  if (rule.requirement.kind === 'element') {
    const groups = rule.requirement.block.groups;
    if (groups.length !== 1) {
      reasons.push(groups.length === 0
        ? 'the requirement has no conditions'
        : 'requirement groups combined with OR cannot be expressed in IDS 1.0');
    } else {
      const mapped = groupToFacets(groups[0], 'requirement', scaleOf);
      if (mapped.ok) {
        notes.push(...mapped.notes);
        mapped.facets.forEach((facet, i) => {
          requirements.push({ id: `${rule.id}-${i + 1}`, facet, optionality: 'required' });
        });
      } else {
        reasons.push(...mapped.reasons.map((r) => `requirement: ${r}`));
      }
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    notes,
    spec: {
      id: rule.id,
      identifier: rule.id,
      name: rule.name,
      ...(rule.description ? { description: rule.description } : {}),
      ifcVersions,
      applicability: { facets: applicabilityFacets },
      requirements,
      ...cardinality,
    },
  };
}

/** Convert `file` to IDS. Never throws; see {@link RuleSetToIdsResult}. */
export function ruleSetToIds(file: RuleSetFile, options: RuleSetToIdsOptions = {}): RuleSetToIdsResult {
  const ifcVersions = options.ifcVersions && options.ifcVersions.length > 0 ? options.ifcVersions : ['IFC4' as const];
  const specifications: IDSSpecification[] = [];
  const exportedRuleIds: string[] = [];
  const refused: RefusedRule[] = [];
  const notes = new Set<string>();
  const scaleOf = options.models ? storedUnitScaleOf(options.models) : undefined;

  for (const rule of file.rules) {
    const outcome = ruleToSpecification(rule, ifcVersions, scaleOf);
    if (outcome.ok) {
      specifications.push(outcome.spec);
      exportedRuleIds.push(rule.id);
      for (const note of outcome.notes) notes.add(note);
      if (outcome.spec.requirements.some((r) => r.facet.type === 'property')
        || outcome.spec.applicability.facets.some((f) => f.type === 'property')) {
        notes.add(NAME_CASE_NOTE);
      }
    } else {
      refused.push({ ruleId: rule.id, ruleName: rule.name, reasons: outcome.reasons });
    }
  }

  const document: IDSDocument = {
    info: { title: file.name, ...(file.description ? { description: file.description } : {}) },
    specifications,
  };
  if (file.targets && ((file.targets.modelFingerprints?.length ?? 0) > 0 || (file.targets.modelTagIds?.length ?? 0) > 0)) {
    notes.add('The rule set\'s default target models are not part of an IDS; choose the model when running it');
  }
  return {
    xml: specifications.length > 0 ? writeIdsXml(document) : null,
    document,
    exportedRuleIds,
    refused,
    notes: [...notes],
  };
}
