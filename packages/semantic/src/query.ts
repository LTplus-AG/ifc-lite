/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Parser } from '@traqula/parser-sparql-1-1';
import { LIMITS, assertIri, isObject } from './types.js';

function parseReadOnly(query: string, authorizedGraphs: readonly string[]): Record<string, unknown> & { subType: 'select' | 'construct' } {
  if (query.length > LIMITS.query) throw new Error('SPARQL query exceeds limit');
  const ast: unknown = new Parser().parse(query);
  if (!isObject(ast) || ast.type !== 'query' || (ast.subType !== 'select' && ast.subType !== 'construct')) throw new Error('Only SELECT and CONSTRUCT queries are supported');
  const pending: unknown[] = [ast];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) pending.push(...current);
    else if (isObject(current)) {
      if (current.subType === 'service') throw new Error('Federated SERVICE queries are not permitted');
      if (current.type === 'datasetClauses' && Array.isArray(current.clauses)) {
        for (const clause of current.clauses) {
          if (!isObject(clause) || !isObject(clause.value) || !authorizedGraphs.includes(String(clause.value.value))) throw new Error('FROM graph has not been explicitly authorized');
        }
      }
      pending.push(...Object.values(current));
    }
  }
  return ast as Record<string, unknown> & { subType: 'select' | 'construct' };
}
/** Parse the grammar first, then inspect nested AST nodes (including subqueries). */
export function assertReadOnlyQuery(query: string, authorizedGraphs: readonly string[] = []): 'select' | 'construct' {
  return parseReadOnly(query, authorizedGraphs).subType;
}
/** Top-level shape of a read-only query: its form, projected variables (`'*'` for a wildcard) and outer LIMIT. */
export interface ReadOnlyQueryShape { form: 'select' | 'construct'; variables: string[] | '*'; limit?: number }
/** The same read-only checks as {@link assertReadOnlyQuery}, plus the outer projection and LIMIT a reviewer needs. */
export function inspectReadOnlyQuery(query: string, authorizedGraphs: readonly string[] = []): ReadOnlyQueryShape {
  const ast = parseReadOnly(query, authorizedGraphs);
  const modifiers = isObject(ast.solutionModifiers) ? ast.solutionModifiers : {};
  const limitOffset = isObject(modifiers.limitOffset) ? modifiers.limitOffset : {};
  const limit = typeof limitOffset.limit === 'number' ? limitOffset.limit : undefined;
  if (ast.subType === 'construct') return { form: 'construct', variables: [], ...(limit === undefined ? {} : { limit }) };
  const projected = Array.isArray(ast.variables) ? ast.variables : [];
  const wildcard = projected.some(item => isObject(item) && item.type === 'wildcard');
  const variables = projected.flatMap(item => {
    if (!isObject(item)) return [];
    const term = item.type === 'term' ? item : isObject(item.variable) ? item.variable : undefined;
    return term && typeof term.value === 'string' ? [term.value] : [];
  });
  return { form: 'select', variables: wildcard ? '*' : variables, ...(limit === undefined ? {} : { limit }) };
}
// Bind each branch from its own triple pattern before joining the outer resource constraints.
const RELATED_PATTERN = '{ ?resource ?predicate ?object BIND(?resource AS ?subject) } UNION { ?subject ?predicate ?resource BIND(?resource AS ?object) }';
function boundedRelatedQuery(selector: string, count: number, limit: number): string {
  if (!count || count > LIMITS.rows || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.rows) throw new Error('Invalid related query bounds');
  const query = `SELECT DISTINCT ?subject ?predicate ?object WHERE { ${selector} ${RELATED_PATTERN} } LIMIT ${limit}`;
  if (query.length > LIMITS.query) throw new Error('Related query exceeds query limit');
  return query;
}
/** VALUES uses validated IRIs, never interpolated user syntax or unescaped literals. */
export function relatedResourceQuery(ids: readonly string[], limit: number = LIMITS.rows): string {
  ids.forEach(assertIri);
  const unique = [...new Set(ids)];
  return boundedRelatedQuery(`VALUES ?resource { ${unique.map(id => `<${id}>`).join(' ')} }`, unique.length, limit);
}
/** Discover subjects by an explicit identity predicate, preserving the same bounded adjacency query. */
export function relatedIdentityQuery(predicate: string, identities: readonly string[], limit: number = LIMITS.rows): string {
  assertIri(predicate);
  if (identities.some(value => typeof value !== 'string')) throw new Error('Identity query values must be strings');
  const unique = [...new Set(identities)];
  const values = unique.map(value => JSON.stringify(value)).join(' ');
  return boundedRelatedQuery(`VALUES ?identity { ${values} } ?resource <${predicate}> ?identity .`, unique.length, limit);
}
