/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute resolution: which value is shown, and is it disputed?
 *
 * For one (path, attribute key) and its opinions (weakest first,
 * strongest last, as `@ifc-lite/ifcx` retains them), the state is the
 * FIRST row that matches:
 *
 *   1 agreed           no governing rule, one value
 *   2 divergent        no governing rule, values differ
 *   3 unconfirmed      rule, but no opinion from a principal in its role
 *   4 authority-split  authoritative opinions hold more than one value
 *   5 contested        one authoritative value, some other opinion differs
 *   6 authoritative    one authoritative value, nobody differs
 *
 * Rows 1-3 show the stack-order winner (the last opinion). Rows 4-6 show
 * the strongest authoritative opinion, regardless of stack order. Values
 * are compared canonically, never principals: two principals holding the
 * same value agree. Pure: the same opinions and charter always give the
 * same result.
 *
 * Spec: docs/architecture/layer-prs/12-authority.md §12.5.
 */

import { findGoverningRule, type AttributeSubject, type Charter } from './charter.js';

/** One layer's value for one attribute (structurally `@ifc-lite/ifcx`'s `AttributeOpinion`). */
export interface Opinion {
  layerId: string;
  /** The layer's `author.principal`; an opinion without one is never authoritative. */
  principal?: string;
  value: unknown;
  /** True when the layer carries a valid signature from `principal` (03 §3.2). */
  signatureVerified?: boolean;
}

export type AttributeState =
  | 'agreed'
  | 'divergent'
  | 'unconfirmed'
  | 'authority-split'
  | 'contested'
  | 'authoritative';

export interface AttributeResolution<O extends Opinion = Opinion> {
  state: AttributeState;
  /** Governing rule id (rows 3-6). */
  ruleId?: string;
  /** Role of the governing rule (rows 3-6). */
  role?: string;
  /** The opinion whose value is shown; undefined only when there are no opinions. */
  shown?: O;
  /** Opinions from principals holding the rule's role, weakest first. */
  authoritative: O[];
  /** Opinions outside the role whose value differs from the shown value (rows 4-5). */
  dissent: O[];
}

export interface ResolveOptions {
  /** Trust level 3: only signature-verified opinions count as authoritative. */
  requireSignature?: boolean;
}

/**
 * Comparison key for an opinion value: the same canonical form as
 * `@ifc-lite/ifcx` uses for opinions (NFC strings, -0 as 0, sorted keys,
 * object members holding `undefined` skipped). A top-level `undefined`
 * (an attribute kept without a value) is distinct from a `null` removal,
 * and values JSON cannot represent (non-finite numbers, bigint, functions,
 * symbols) get tagged keys, so `NaN` never equals a removal.
 */
export function canonicalValueKey(value: unknown, nested = false): string {
  if (value === undefined && !nested) return '\u0000undefined';
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'number':
      if (!Number.isFinite(value)) return `\u0000number:${value}`;
      return JSON.stringify(value === 0 ? 0 : value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalValueKey(item, true)).join(',')}]`;
      const record = value as Record<string, unknown>;
      // Sort by the NFC form, so two spellings of one key order the same;
      // the raw key breaks ties when one object holds both spellings.
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .map((key) => [key.normalize('NFC'), key] as const)
        .sort(([a, rawA], [b, rawB]) => (a !== b ? (a < b ? -1 : 1) : rawA < rawB ? -1 : rawA > rawB ? 1 : 0));
      return `{${members.map(([nfc, key]) => `${JSON.stringify(nfc)}:${canonicalValueKey(record[key], true)}`).join(',')}}`;
    }
    default:
      return `\u0000${typeof value}:${String(value)}`;
  }
}

function distinctValues(opinions: readonly Opinion[]): number {
  return new Set(opinions.map((o) => canonicalValueKey(o.value))).size;
}

/** Resolve one attribute's opinions against a charter (or none). */
export function resolveAttribute<O extends Opinion>(
  subject: AttributeSubject,
  opinions: readonly O[],
  charter?: Charter,
  options: ResolveOptions = {}
): AttributeResolution<O> {
  const strongest = opinions.length > 0 ? opinions[opinions.length - 1] : undefined;
  const rule = charter ? findGoverningRule(charter, subject) : undefined;

  if (!rule || !charter) {
    const state = distinctValues(opinions) > 1 ? 'divergent' : 'agreed';
    return { state, shown: strongest, authoritative: [], dissent: [] };
  }

  const holders = charter.roles.get(rule.role) ?? new Set<string>();
  const isAuthoritative = (o: Opinion) =>
    o.principal !== undefined && holders.has(o.principal) && (!options.requireSignature || o.signatureVerified === true);
  const authoritative = opinions.filter(isAuthoritative);
  const base = { ruleId: rule.id, role: rule.role, authoritative };

  if (authoritative.length === 0) {
    return { ...base, state: 'unconfirmed', shown: strongest, dissent: [] };
  }

  const shown = authoritative[authoritative.length - 1];
  const shownKey = canonicalValueKey(shown.value);
  const dissent = opinions.filter((o) => !isAuthoritative(o) && canonicalValueKey(o.value) !== shownKey);
  if (distinctValues(authoritative) > 1) return { ...base, state: 'authority-split', shown, dissent };
  return { ...base, state: dissent.length > 0 ? 'contested' : 'authoritative', shown, dissent };
}
