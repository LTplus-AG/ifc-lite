/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clashMemberSet, inClashSet } from '../members.js';
import { inferClashSeverity } from '../disciplines.js';
import { isExcluded, qualifiedKey } from '../exclude.js';
import { summarizeClashes } from '../analysis.js';
import {
  DEFAULT_CLASH_SETTINGS,
  type Clash,
  type ClashElement,
  type ClashElementRef,
  type ClashResult,
  type ClashRule,
  type ClashRuleCoverage,
  type ClashSettings,
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

  const clashes: Clash[] = [];
  const ruleCoverage: ClashRuleCoverage[] = [];
  const seen = new Set<string>();
  let droppedPairs = 0;
  // A single GLOBAL candidate-pair budget across the whole run (not per rule),
  // so `maxCandidatePairs` is an honest end-to-end guardrail.
  let remaining = maxPairs;

  // `finally` guarantees the kernel is disposed even on abort / kernel error /
  // a throw inside prepare() — otherwise a `WasmKernel`'s `ClashSession` (and
  // its arenas) would leak.
  try {
    kernel.prepare(elements);
    for (const rule of rules) {
      if (settings.signal?.aborted) {
        throw new DOMException('Clash run aborted', 'AbortError');
      }

      const groupA: number[] = [];
      // A second side exists when the rule names one — by selector OR by
      // membership. Keying only on `b` would silently drop a `membersB` the
      // caller gave without a selector and turn the rule into a self-clash.
      const groupB: number[] | null = rule.b !== undefined || rule.membersB ? [] : null;
      // Membership when the rule carries one, type selector otherwise — the
      // ONE place a rule's sides are resolved, so both kernels see the same
      // partition and every later stage is unaware there are two ways in.
      const membersA = clashMemberSet(rule.membersA);
      const membersB = clashMemberSet(rule.membersB);
      // Durable keys of everything each side matched, for `compareClashRevisions`
      // (revision.ts) to answer "was this SPECIFIC element re-examined?" — a
      // count alone (`matchedA`/`matchedB`) cannot tell a narrowed selector that
      // dropped one previously-matched element from one that kept it. Bounded by
      // the same element set already held in memory for this run, so it costs
      // nothing beyond the string references (deduplicated by `Set`).
      const matchedKeysA = new Set<string>();
      const matchedKeysB: Set<string> | null = groupB ? new Set<string>() : null;
      for (let i = 0; i < elements.length; i += 1) {
        const el = elements[i];
        if (inClashSet(el, rule.a, membersA)) {
          groupA.push(i);
          matchedKeysA.add(el.key);
        }
        if (groupB && inClashSet(el, rule.b ?? '', membersB)) {
          groupB.push(i);
          matchedKeysB!.add(el.key);
        }
      }
      ruleCoverage.push({
        rule: rule.id,
        matchedA: groupA.length,
        matchedB: groupB ? groupB.length : null,
        matchedKeysA: [...matchedKeysA].sort(),
        matchedKeysB: matchedKeysB ? [...matchedKeysB].sort() : null,
        ...(membersA ? { fromMembersA: true } : {}),
        ...(membersB ? { fromMembersB: true } : {}),
      });

      const ruleTolerance = rule.tolerance ?? tolerance;
      settings.onProgress?.({ phase: 'broad', rule: rule.id, done: 0, total: 0 });

      const { records, candidatesProcessed, candidatesDropped } = await kernel.detectRule(
        elements,
        groupA,
        groupB,
        rule,
        ruleTolerance,
        remaining,
        settings.signal,
        settings.onProgress
          ? (done, total) => settings.onProgress!({ phase: 'narrow', rule: rule.id, done, total })
          : undefined,
      );
      remaining = Math.max(0, remaining - candidatesProcessed);
      droppedPairs += candidatesDropped;

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
          distanceKind: rec.distanceKind,
          point: rec.point,
          bounds: rec.bounds,
          severity: rule.severity ?? inferClashSeverity(elA.tag, elB.tag),
        });
      }
    }
  } finally {
    kernel.dispose?.();
  }

  clashes.sort(byKeyThenRule);

  const result: ClashResult = {
    clashes,
    summary: summarizeClashes(clashes),
    // Without the resolved membership: `rulesRun` is the DESCRIPTION of what
    // ran, kept in store state and structured-cloned into the script sandbox,
    // while a member list is run state that can hold a quarter-million strings
    // per side. `ruleCoverage` reports how many elements each side matched,
    // which is the part a reader of a finished run wants.
    rulesRun: rules.map(withoutMembership),
    ruleCoverage,
    settings: { tolerance, excludeVoidsAndHosts },
  };
  if (droppedPairs > 0) {
    result.truncated = { reason: 'maxCandidatePairs', droppedPairs };
  }
  return result;
}

/** A rule as it is reported back: config only, no resolved membership. */
function withoutMembership(rule: ClashRule): ClashRule {
  if (!rule.membersA && !rule.membersB) return rule;
  const { membersA: _a, membersB: _b, ...config } = rule;
  return config;
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

