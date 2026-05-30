/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesSelector } from '../selectors.js';
import { inferClashSeverity } from '../disciplines.js';
import { isExcluded } from '../exclude.js';
import {
  DEFAULT_CLASH_SETTINGS,
  type Clash,
  type ClashElement,
  type ClashElementRef,
  type ClashResult,
  type ClashRule,
  type ClashSettings,
  type ClashSeverity,
  type ClashSummary,
} from '../types.js';
import { candidatePairs } from './broad.js';
import { testPair } from './narrow.js';
import { TriMesh } from './tri-mesh.js';

/** A clash engine: a pure async function of (elements, rules, settings). */
export interface ClashEngine {
  run(elements: ClashElement[], rules: ClashRule[], settings?: ClashSettings): Promise<ClashResult>;
}

/** Reference engine: spatial BVH broad phase + exact triangle narrow phase. */
export class TsClashEngine implements ClashEngine {
  async run(
    elements: ClashElement[],
    rules: ClashRule[],
    settings: ClashSettings = {},
  ): Promise<ClashResult> {
    const tolerance = settings.tolerance ?? DEFAULT_CLASH_SETTINGS.tolerance;
    const excludeVoidsAndHosts =
      settings.excludeVoidsAndHosts ?? DEFAULT_CLASH_SETTINGS.excludeVoidsAndHosts;
    const exclusions = excludeVoidsAndHosts ? settings.exclusions : undefined;
    const maxPairs = settings.maxCandidatePairs ?? Infinity;

    const triCache = new WeakMap<ClashElement, TriMesh>();
    const triFor = (el: ClashElement): TriMesh => {
      let mesh = triCache.get(el);
      if (!mesh) {
        mesh = new TriMesh(el.positions, el.indices, el.transform);
        triCache.set(el, mesh);
      }
      return mesh;
    };

    const clashes: Clash[] = [];
    const seen = new Set<string>();
    let droppedPairs = 0;

    for (const rule of rules) {
      const groupA = elements.filter((e) => matchesSelector(e.tag, rule.a));
      const groupB = rule.b ? elements.filter((e) => matchesSelector(e.tag, rule.b!)) : null;
      const ruleTolerance = rule.tolerance ?? tolerance;
      const margin = Math.max(ruleTolerance, rule.clearance ?? 0);

      const pairs = candidatePairs(groupA, groupB, margin);
      settings.onProgress?.({ phase: 'broad', rule: rule.id, done: pairs.length, total: pairs.length });

      const resolveB = groupB ?? groupA;
      let processed = 0;
      for (const [i, j] of pairs) {
        if (settings.signal?.aborted) {
          throw new DOMException('Clash run aborted', 'AbortError');
        }
        if (processed >= maxPairs) {
          droppedPairs += pairs.length - processed;
          break;
        }
        processed += 1;

        const elA = groupA[i];
        const elB = resolveB[j];
        if (exclusions && isExcluded(exclusions, elA.key, elB.key)) continue;

        const res = testPair(elA, triFor(elA), elB, triFor(elB), rule, ruleTolerance);
        settings.onProgress?.({ phase: 'narrow', rule: rule.id, done: processed, total: pairs.length });
        if (!res) continue;

        const id = clashId(elA, elB, rule.id);
        if (seen.has(id)) continue;
        seen.add(id);

        clashes.push({
          id,
          a: toRef(elA),
          b: toRef(elB),
          rule: rule.id,
          status: res.status,
          distance: res.distance,
          point: res.point,
          bounds: res.bounds,
          severity: rule.severity ?? inferClashSeverity(elA.tag, elB.tag),
        });
      }
    }

    clashes.sort(byKeyThenRule);

    const result: ClashResult = {
      clashes,
      summary: buildSummary(clashes),
      rulesRun: rules,
      settings: { tolerance, excludeVoidsAndHosts },
    };
    if (droppedPairs > 0) {
      result.truncated = { reason: 'maxCandidatePairs', droppedPairs };
    }
    return result;
  }
}

function toRef(el: ClashElement): ClashElementRef {
  return { key: el.key, ref: el.ref, model: el.model, tag: el.tag, name: el.name };
}

/** Stable, deterministic clash identity from the two durable keys + rule. */
function clashId(a: ClashElement, b: ClashElement, ruleId: string): string {
  const ka = `${a.model} ${a.key}`;
  const kb = `${b.model} ${b.key}`;
  const [lo, hi] = ka < kb ? [ka, kb] : [kb, ka];
  return `${ruleId} ${lo} ${hi}`;
}

function byKeyThenRule(x: Clash, y: Clash): number {
  return (
    cmp(x.a.key, y.a.key) ||
    cmp(x.b.key, y.b.key) ||
    cmp(x.rule, y.rule)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildSummary(clashes: Clash[]): ClashSummary {
  const byRule: Record<string, number> = {};
  const byTypePair: Record<string, number> = {};
  const bySeverity: Record<ClashSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) {
    byRule[c.rule] = (byRule[c.rule] ?? 0) + 1;
    const pair = [c.a.tag, c.b.tag].sort().join(' vs ');
    byTypePair[pair] = (byTypePair[pair] ?? 0) + 1;
    bySeverity[c.severity] += 1;
  }
  return { total: clashes.length, byRule, byTypePair, bySeverity };
}
