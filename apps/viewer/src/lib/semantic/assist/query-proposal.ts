/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_MAPPING, LIMITS, inspectReadOnlyQuery, type BindingMapping } from '@ifc-lite/semantic';
import { onlyKeys, parseEnvelope, record, text } from './proposal-common';

/** A bounded read query the user may run against their own granted endpoint. */
export interface SemanticQueryProposal {
  version: 1; kind: 'semantic.query'; title: string; purpose: string; query: string;
  expected: { form: 'select'; columns: string[] } | { form: 'construct' };
  /** Result columns that carry identity (GlobalId, modelRevision, id); defaults to the native mapping. */
  mapping: BindingMapping;
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function parseSemanticQuery(answer: string): SemanticQueryProposal {
  const value = parseEnvelope(answer, 'semantic.query', ['purpose', 'query', 'expected', 'mapping']);
  if (!text(value.purpose, 1000)) throw new Error('A query proposal must state its purpose');
  if (!text(value.query, LIMITS.query)) throw new Error('A query proposal needs SPARQL text');
  if (!record(value.expected)) throw new Error('A query proposal must state the expected result shape');
  onlyKeys(value.expected, ['form', 'columns'], 'The expected result shape');
  let expected: SemanticQueryProposal['expected'];
  if (value.expected.form === 'construct') {
    if (value.expected.columns !== undefined) throw new Error('A CONSTRUCT result has no columns');
    expected = { form: 'construct' };
  } else if (value.expected.form === 'select') {
    const columns = value.expected.columns;
    if (!Array.isArray(columns) || !columns.length || columns.length > 64
      || !columns.every(column => typeof column === 'string' && VARIABLE.test(column)) || new Set(columns).size !== columns.length) {
      throw new Error('A SELECT result must list its distinct column names');
    }
    expected = { form: 'select', columns: [...columns] as string[] };
  } else throw new Error('The expected form must be "select" or "construct"');
  let mapping: BindingMapping = { ...DEFAULT_MAPPING };
  if (value.mapping !== undefined) {
    if (!record(value.mapping) || Object.keys(value.mapping).length > 16) throw new Error('The identity mapping must be a small object');
    for (const [field, column] of Object.entries(value.mapping)) {
      if (!VARIABLE.test(field) || typeof column !== 'string' || !VARIABLE.test(column)) throw new Error('The identity mapping must map field names to column names');
    }
    mapping = { ...DEFAULT_MAPPING, ...value.mapping as BindingMapping };
  }
  return { version: 1, kind: 'semantic.query', title: (value.title as string).trim(), purpose: value.purpose, query: value.query, expected, mapping };
}

export type QueryLint = { ok: true; form: 'select' | 'construct'; limit: number } | { ok: false; issues: string[] };

/**
 * Native lint: the semantic package's SPARQL parser enforces the read-only
 * forms, refuses SERVICE and unauthorized FROM graphs; the reviewer also needs
 * the declared shape to match and an explicit LIMIT within the native row bound.
 */
export function lintSemanticQuery(proposal: SemanticQueryProposal, authorizedGraphs: readonly string[] = []): QueryLint {
  let shape: ReturnType<typeof inspectReadOnlyQuery>;
  try { shape = inspectReadOnlyQuery(proposal.query, authorizedGraphs); }
  catch (error) { return { ok: false, issues: [error instanceof Error ? error.message : String(error)] }; }
  const issues: string[] = [];
  if (shape.form !== proposal.expected.form) issues.push(`The query is ${shape.form.toUpperCase()}, but the proposal expects ${proposal.expected.form.toUpperCase()}`);
  if (shape.form === 'select' && proposal.expected.form === 'select') {
    if (shape.variables === '*') issues.push('SELECT * cannot be checked against the expected columns; name each column');
    else {
      const actual = [...shape.variables].sort().join(', ');
      const declared = [...proposal.expected.columns].sort().join(', ');
      if (actual !== declared) issues.push(`The query returns columns ${actual || '(none)'}, but the proposal expects ${declared}`);
    }
  }
  if (shape.limit === undefined) issues.push(`Add an outer LIMIT of at most ${LIMITS.rows}`);
  else if (shape.limit < 1 || shape.limit > LIMITS.rows) issues.push(`The LIMIT must be between 1 and ${LIMITS.rows}`);
  return issues.length || shape.limit === undefined ? { ok: false, issues } : { ok: true, form: shape.form, limit: shape.limit };
}
