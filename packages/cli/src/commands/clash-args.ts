/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite clash` argument parsing: modes, numeric flags, BCF grouping and
 * the rule set. Split out of `clash.ts` to keep it under the module-size
 * budget (#4879).
 */

import { getFlag, hasFlag, fatal } from '../output.js';
import { disciplineMatrixRules, type ClashMode, type ClashRule } from '@ifc-lite/clash';

export function parseMode(raw: string | undefined): ClashMode {
  const mode = raw ?? 'hard';
  if (mode !== 'hard' && mode !== 'clearance') {
    fatal(`Invalid --mode "${mode}". Supported modes: hard, clearance`);
  }
  return mode;
}

export function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    fatal(`Invalid ${flag} value "${raw}" (must be a number)`);
  }
  return value;
}

type ClashGroupByCli = 'cluster' | 'rule' | 'typePair' | 'element';

export function parseGroupBy(raw: string | undefined): ClashGroupByCli {
  const g = raw ?? 'cluster';
  if (g !== 'cluster' && g !== 'rule' && g !== 'typePair' && g !== 'element') {
    fatal(`Invalid --group "${g}". Supported: cluster, rule, typePair, element`);
  }
  return g as ClashGroupByCli;
}

export function buildRules(args: string[], mode: ClashMode, tolerance: number | undefined, clearance: number | undefined): ClashRule[] {
  if (hasFlag(args, '--matrix')) {
    return disciplineMatrixRules(mode, clearance);
  }

  const a = getFlag(args, '--a') ?? '*';
  const b = getFlag(args, '--b');
  const rule: ClashRule = {
    id: 'cli-rule',
    name: b ? `${a} vs ${b}` : `${a} self-clash`,
    a,
    mode,
  };
  if (b !== undefined) rule.b = b;
  if (tolerance !== undefined) rule.tolerance = tolerance;
  if (clearance !== undefined) rule.clearance = clearance;
  return [rule];
}
