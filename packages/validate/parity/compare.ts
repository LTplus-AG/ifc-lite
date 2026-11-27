/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-rule agreement between our findings and the oracle's, at instance level. */

import type { ValidationFinding } from '../src/index.js';
import { keyString, oracleKey, ourKey, ruleFamily, type OracleFinding } from './normalize.js';

export interface FileComparison {
  path: string;
  kind: 'crafted' | 'real';
  targets?: string;
  schema: string;
  ours: number;
  oracle: number;
  tp: string[];
  fp: string[];
  fn: string[];
  oracleError?: string;
  milliseconds: number;
}

export interface RuleRow {
  rule: string;
  tp: number;
  fp: number;
  fn: number;
  /** The oracle records findings only, so successful per-file rule evaluations are unknown. */
  tnFiles: null;
  explained?: string;
}

export function compareFile(
  path: string,
  kind: FileComparison['kind'],
  schema: string,
  ours: ValidationFinding[],
  oracle: OracleFinding[],
  milliseconds: number,
  targets?: string,
  oracleError?: string,
): FileComparison {
  const counts = new Map<string, number>();
  for (const f of oracle) {
    const key = keyString(oracleKey(f));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const tp: string[] = [], fp: string[] = [], fn: string[] = [];
  for (const f of ours) {
    const key = keyString(ourKey(f));
    const left = counts.get(key) ?? 0;
    if (left > 0) {
      tp.push(key);
      counts.set(key, left - 1);
    } else fp.push(key);
  }
  for (const [key, left] of counts) for (let i = 0; i < left; i++) fn.push(key);
  return {
    path, kind, schema, ours: ours.length, oracle: oracle.length, milliseconds, tp, fp, fn,
    ...(targets ? { targets } : {}),
    ...(oracleError ? { oracleError } : {}),
  };
}

export interface Explanation {
  rule: string;
  kind: 'fp' | 'fn';
  reason: string;
}

export function ruleTable(files: FileComparison[], explanations: Explanation[]): RuleRow[] {
  const rows = new Map<string, RuleRow>();
  const row = (rule: string) => {
    let r = rows.get(rule);
    if (!r) rows.set(rule, (r = { rule, tp: 0, fp: 0, fn: 0, tnFiles: null }));
    return r;
  };
  for (const f of files) {
    for (const k of f.tp) row(ruleFamily(k.split('|')[0])).tp++;
    for (const k of f.fp) row(ruleFamily(k.split('|')[0])).fp++;
    for (const k of f.fn) row(ruleFamily(k.split('|')[0])).fn++;
  }
  for (const r of rows.values()) {
    const why = explanations.filter((e) => e.rule.toLowerCase() === r.rule && ((e.kind === 'fp' && r.fp) || (e.kind === 'fn' && r.fn)));
    if (why.length) r.explained = why.map((e) => `${e.kind.toUpperCase()}: ${e.reason}`).join(' ');
  }
  return [...rows.values()].sort((x, y) => y.fn - x.fn || y.fp - x.fp || x.rule.localeCompare(y.rule));
}
