/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Import the simple specifications of an IDS document as rules (#5225), so
 * an incoming deliverable can be extended with checks IDS cannot express.
 *
 * A specification imports when every facet has an exact rule equivalent:
 * entity, attribute and property facets (and classification presence,
 * material) whose constraints are simple values, patterns, enumerations or
 * numeric bounds. Anything else blocks THAT specification with a named
 * reason rather than being approximated: partOf, optional and prohibited
 * facets, a pattern on an entity or attribute NAME,
 * length/digit restrictions. The per-facet mapping is in
 * `ids-facet-to-rules.ts`.
 */

import type { IDSDocument, IDSSpecification } from '@ifc-lite/ids';
import type { FilterRule } from '../filter/filter-rules.js';
import type { InformationRule, RuleSetFile } from '../rule-set/rule-set.js';
import { RULE_SET_VERSION } from '../rule-set/rule-set.js';
import { facetToRules } from './ids-facet-to-rules.js';

export interface IdsToRuleSetOptions {
  /** Id for a rule whose specification has no usable `identifier`. Default: `crypto.randomUUID()`. */
  newId?: () => string;
}

export interface RefusedSpecification {
  specificationName: string;
  reasons: string[];
}

export interface IdsToRuleSetResult {
  /** `null` when no specification could be imported. */
  file: RuleSetFile | null;
  refused: RefusedSpecification[];
  /** Caveats that apply to the imported rules as a whole. */
  notes: string[];
  /**
   * Checks the IDS makes that the imported rules do not, one entry per
   * dropped check as `"<rule name>: <what>"` (today: a property facet's
   * `dataType`, which the rule vocabulary cannot check, #5225).
   */
  droppedChecks: string[];
}

const ALL_VERSIONS_NOTE =
  'IDS specifications limited to some IFC versions were imported as rules that run on every model';

type RuleOutcome = { ok: true; rule: InformationRule; dropped: string[] } | { ok: false; reasons: string[] };

function cardinalityOf(spec: IDSSpecification, reasons: string[]): InformationRule['cardinality'] | undefined {
  const min = spec.minOccurs ?? 0;
  const max = spec.maxOccurs ?? 'unbounded';
  if (max === 'unbounded') return min > 0 ? { minApplicable: min } : undefined;
  if (max < min) {
    reasons.push(`maxOccurs ${max} is below minOccurs ${min}`);
    return undefined;
  }
  return { ...(min > 0 ? { minApplicable: min } : {}), maxApplicable: max };
}

function specificationToRule(spec: IDSSpecification, id: string): RuleOutcome {
  const reasons: string[] = [];
  const dropped: string[] = [];
  const cardinality = cardinalityOf(spec, reasons);

  const applicability: FilterRule[] = [];
  for (const facet of spec.applicability.facets) {
    const mapped = facetToRules(facet, 'applicability');
    if (mapped.ok) {
      applicability.push(...mapped.rules);
      dropped.push(...(mapped.dropped ?? []));
    }
    else reasons.push(`applicability: ${mapped.reason}`);
  }
  if (spec.applicability.facets.length === 0) reasons.push('the applicability has no facets');

  const requirement: FilterRule[] = [];
  for (const req of spec.requirements) {
    if (req.optionality !== 'required') {
      reasons.push(
        req.optionality === 'optional'
          ? `requirements: an optional ${req.facet.type} facet ("if present, must match") has no rule equivalent`
          : `requirements: a prohibited ${req.facet.type} facet has no rule equivalent`,
      );
      continue;
    }
    const mapped = facetToRules(req.facet, 'requirement');
    if (mapped.ok) {
      requirement.push(...mapped.rules);
      dropped.push(...(mapped.dropped ?? []));
    }
    else reasons.push(`requirements: ${mapped.reason}`);
  }
  if (spec.requirements.length === 0) {
    reasons.push('a specification without requirements has no rule equivalent (a rule always checks something)');
  }

  if (reasons.length > 0) return { ok: false, reasons };
  const description = [spec.description, spec.instructions].filter((s): s is string => !!s).join('\n\n');
  return {
    ok: true,
    dropped,
    rule: {
      id,
      name: spec.name || id,
      ...(description ? { description } : {}),
      applicability: { groups: [{ rules: applicability, combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: requirement, combinator: 'AND' }], authoredAs: 'chips' } },
      ...(cardinality ? { cardinality } : {}),
    },
  };
}

const ALL_VERSIONS = new Set(['IFC2X3', 'IFC4', 'IFC4X3', 'IFC4X3_ADD2']);

/** Convert the simple specifications of `doc` to a rule set. Never throws. */
export function idsToRuleSet(doc: IDSDocument, options: IdsToRuleSetOptions = {}): IdsToRuleSetResult {
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  const usedIds = new Set<string>();
  const rules: InformationRule[] = [];
  const refused: RefusedSpecification[] = [];
  const notes = new Set<string>();
  const droppedChecks: string[] = [];

  doc.specifications.forEach((spec, index) => {
    const identifier = spec.identifier?.trim();
    const id = identifier && !usedIds.has(identifier) ? identifier : newId();
    const outcome = specificationToRule(spec, id);
    if (!outcome.ok) {
      refused.push({ specificationName: spec.name || `Specification ${index + 1}`, reasons: outcome.reasons });
      return;
    }
    usedIds.add(id);
    rules.push(outcome.rule);
    for (const loss of outcome.dropped) droppedChecks.push(`${outcome.rule.name}: ${loss}`);
    const versions = new Set<string>(spec.ifcVersions);
    if (![...ALL_VERSIONS].every((v) => versions.has(v) || (v === 'IFC4X3' && versions.has('IFC4X3_ADD2')) || (v === 'IFC4X3_ADD2' && versions.has('IFC4X3')))) {
      notes.add(ALL_VERSIONS_NOTE);
    }
  });

  const file: RuleSetFile | null = rules.length === 0 ? null : {
    version: RULE_SET_VERSION,
    name: doc.info.title || 'Imported IDS',
    ...(doc.info.description ? { description: doc.info.description } : {}),
    rules,
  };
  return { file, refused, notes: [...notes], droppedChecks };
}
