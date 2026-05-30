/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchesSelector } from '../selectors.js';
import { inferClashSeverity } from '../disciplines.js';
import { isExcluded, qualifiedKey } from '../exclude.js';
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
import type { ClashKernel } from './kernel.js';

/**
 * Backend-agnostic clash orchestration: selection, exclusions, severity, stable
 * identity, dedup, ordering and summary. The geometry (broad + narrow phase) is
 * delegated to a `ClashKernel` (TypeScript or Rust/WASM), so swapping backends
 * changes nothing observable except speed — which is exactly what makes the two
 * engines differentially comparable.
 */
export async function runClash(
  elements: ClashElement[],
  rules: ClashRule[],
  settings: ClashSettings,
  kernel: ClashKernel,
): Promise<ClashResult> {
  const tolerance = settings.tolerance ?? DEFAULT_CLASH_SETTINGS.tolerance;
  const excludeVoidsAndHosts =
    settings.excludeVoidsAndHosts ?? DEFAULT_CLASH_SETTINGS.excludeVoidsAndHosts;
  const exclusions = excludeVoidsAndHosts ? settings.exclusions : undefined;
  const maxPairs = settings.maxCandidatePairs ?? Infinity;

  kernel.prepare(elements);

  const clashes: Clash[] = [];
  const seen = new Set<string>();
  let droppedPairs = 0;
  // A single GLOBAL candidate-pair budget across the whole run (not per rule),
  // so `maxCandidatePairs` is an honest end-to-end guardrail.
  let remaining = maxPairs;

  // `finally` guarantees the kernel is disposed even on abort / kernel error —
  // otherwise a `WasmKernel`'s `ClashSession` (and its arenas) would leak.
  try {
    for (const rule of rules) {
      if (settings.signal?.aborted) {
        throw new DOMException('Clash run aborted', 'AbortError');
      }

      const groupA: number[] = [];
      const groupB: number[] | null = rule.b ? [] : null;
      for (let i = 0; i < elements.length; i += 1) {
        const tag = elements[i].tag;
        if (matchesSelector(tag, rule.a)) groupA.push(i);
        if (groupB && matchesSelector(tag, rule.b!)) groupB.push(i);
      }

      const ruleTolerance = rule.tolerance ?? tolerance;
      settings.onProgress?.({ phase: 'broad', rule: rule.id, done: 0, total: 0 });

      const { records, candidatesProcessed, candidatesDropped } = kernel.detectRule(
        elements,
        groupA,
        groupB,
        rule,
        ruleTolerance,
        remaining,
        settings.signal,
      );
      remaining = Math.max(0, remaining - candidatesProcessed);
      droppedPairs += candidatesDropped;

      let processed = 0;
      for (const rec of records) {
        if (settings.signal?.aborted) {
          throw new DOMException('Clash run aborted', 'AbortError');
        }
        const elA = elements[rec.a];
        const elB = elements[rec.b];
        // Same durable key + model = one entity split across geometry sub-prims
        // (common in IFC5/USD), not a self-clash. Filter here so every kernel —
        // TS or WASM, regardless of how its broad phase dedups — behaves alike.
        if (elA.key === elB.key && elA.model === elB.model) continue;
        if (
          exclusions &&
          isExcluded(exclusions, qualifiedKey(elA.model, elA.key), qualifiedKey(elB.model, elB.key))
        ) {
          continue;
        }

        const id = clashId(elA, elB, rule.id);
        if (seen.has(id)) continue;
        seen.add(id);

        clashes.push({
          id,
          a: toRef(elA),
          b: toRef(elB),
          rule: rule.id,
          status: rec.status,
          distance: rec.distance,
          point: rec.point,
          bounds: rec.bounds,
          severity: rule.severity ?? inferClashSeverity(elA.tag, elB.tag),
        });
        processed += 1;
        settings.onProgress?.({ phase: 'narrow', rule: rule.id, done: processed, total: records.length });
      }
    }
  } finally {
    kernel.dispose?.();
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
  return cmp(x.a.key, y.a.key) || cmp(x.b.key, y.b.key) || cmp(x.rule, y.rule);
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
