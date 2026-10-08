/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_MAPPING, LIMITS, inspectReadOnlyQuery, type BindingMapping } from '@ifc-lite/semantic';
import type { SemanticQueryProposal } from './query-proposal';

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

/** Identity columns the proposal names, completed by the native default mapping. */
export function effectiveMapping(proposal: SemanticQueryProposal): BindingMapping {
  return { ...DEFAULT_MAPPING, ...proposal.mapping };
}
