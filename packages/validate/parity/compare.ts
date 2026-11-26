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
  /** Rules evaluated per file, for true-negative counting. */
  rules: Set<string>;
  oracleError?: string;
  milliseconds: number;
}

export interface RuleRow {
  rule: string;
  tp: number;
  fp: number;
  fn: number;
  /** Files in which neither side reported the rule although it was reported somewhere in the corpus. */
  tnFiles: number;
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
  const a = new Set(ours.map((f) => keyString(ourKey(f))));
  const b = new Set<string>();
  for (const f of oracle) {
    const key = keyString(oracleKey(f));
    const [rule, instance] = key.split('|');
    if (!rule.endsWith(':?')) {
      b.add(key);
      continue;
    }
    const family = rule.slice(0, -1);
    b.add([...a].find((k) => k.startsWith(family) && k.endsWith(`|${instance}`)) ?? key);
  }
  const rules = new Set([...a, ...b].map((k) => ruleFamily(k.split('|')[0])));
  return {
    path, kind, schema, ours: a.size, oracle: b.size, milliseconds, rules,
    tp: [...a].filter((k) => b.has(k)),
    fp: [...a].filter((k) => !b.has(k)),
    fn: [...b].filter((k) => !a.has(k)),
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
    if (!r) rows.set(rule, (r = { rule, tp: 0, fp: 0, fn: 0, tnFiles: 0 }));
    return r;
  };
  for (const f of files) {
    for (const k of f.tp) row(ruleFamily(k.split('|')[0])).tp++;
    for (const k of f.fp) row(ruleFamily(k.split('|')[0])).fp++;
    for (const k of f.fn) row(ruleFamily(k.split('|')[0])).fn++;
  }
  for (const r of rows.values()) {
    r.tnFiles = files.filter((f) => !f.rules.has(r.rule)).length;
    const why = explanations.filter((e) => e.rule.toLowerCase() === r.rule && ((e.kind === 'fp' && r.fp) || (e.kind === 'fn' && r.fn)));
    if (why.length) r.explained = why.map((e) => `${e.kind.toUpperCase()}: ${e.reason}`).join(' ');
  }
  return [...rows.values()].sort((x, y) => y.fn - x.fn || y.fp - x.fp || x.rule.localeCompare(y.rule));
}
