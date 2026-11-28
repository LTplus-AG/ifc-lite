/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A serialisable, immutable record of one clash run over a slot federation.
 *
 * A host that coordinates in rounds pins every slot (one discipline model) to
 * an exact model version, runs clash detection, and stores the run. Later it
 * compares two stored runs (`compareClashRunDocuments`) and carries review
 * decisions forward (`carryForwardReviews`). Both need the run to say, on its
 * own, what it examined: which model version sat in each slot, which rules ran
 * under which semantics, with which engine and settings, and which elements
 * each rule actually matched. That is the manifest. The findings carry
 * slot-qualified review keys (`clashSlotReviewKey`), so a
 * decision follows the element in its slot, never an ephemeral per-load id.
 *
 * Plain JSON only: no Maps, typed arrays or class instances, so a host can
 * store the document as-is. `validateClashRunDocument` checks one read back.
 */

import { uuidFromSeed } from './deterministic-uuid.js';
import { bareIfcGuid } from './export/table.js';
import { decodeQualifiedPair } from './exclude.js';
import { clashReviewKey, clashSlotReviewKey } from './review.js';
import type { Clash, ClashDistanceKind, ExclusionSet, ClashResult, ClashReview, ClashRule, ClashSeverity, ClashStatus, Vec3 } from './types.js';

/** `$id` of the run-document schema; also the document's `schema` field. */
export const CLASH_RUN_DOCUMENT_SCHEMA_ID = 'https://ifclite.dev/schemas/clash-run/v1.json';
/** Version of the run-document layout. Bumped only on an incompatible change. */
export const CLASH_RUN_DOCUMENT_VERSION = 1;
/** Label every run produced in a browser carries: the host did not run it itself. */
export const CLASH_RUN_BROWSER_SUBMITTED = 'browser-submitted';

/** A slot as the run saw it. `sha256` is `null` when the host did not pin a version. */
export interface ClashRunSlot {
  slot: string;
  sha256: string | null;
  label?: string;
  name?: string;
}

/** A rule as it ran, with the revision that names its semantics. */
export interface ClashRunRule {
  id: string;
  name: string;
  revision: string;
  a: string;
  b: string | null;
  mode: ClashRule['mode'];
  tolerance: number;
  clearance: number | null;
  reportTouch: boolean;
  /** Sides resolved from explicit membership (a host filter) rather than the type selector. */
  explicitMembers: { a: boolean; b: boolean };
}

/** Per-rule coverage: what each rule matched, per slot. */
export interface ClashRunCoverage {
  rule: string;
  matchedA: number;
  matchedB: number | null;
  candidatesExamined: number | null;
  /** Durable keys this rule matched, per slot, sorted. `null`: the engine did not record them. */
  examined: Record<string, string[]> | null;
}

export interface ClashRunManifest {
  slots: ClashRunSlot[];
  rules: { revision: string; items: ClashRunRule[] };
  engine: { name: string; version: string | null; build: string | null; backend: string | null };
  settings: { tolerance: number; excludeVoidsAndHosts: boolean };
  coverage: ClashRunCoverage[];
  /** Keys repeated by distinct objects within one slot: no stable identity, so no carried decision. */
  ambiguousKeys: Record<string, string[]>;
  /**
   * Element pairs the run was told to skip (voids/hosts, user exclusions), as
   * `slotExclusionId`s, sorted. `null`: not recorded, so the absence of a
   * finding cannot be told apart from an exclusion.
   */
  exclusions: string[] | null;
  truncated: { reason: string; droppedPairs: number } | null;
}

/** One side of a finding. */
export interface ClashRunEndpoint {
  slot: string;
  key: string;
  /** The IFC GlobalId when `key` is one, else `null` (USD prim path, synthetic key). */
  globalId: string | null;
  type: string;
  name?: string;
  ambiguous?: true;
}

export interface ClashRunFinding {
  /** Unique within this run only. */
  id: string;
  /** Slot-qualified review key; `null` when either side has no stable identity. */
  key: string | null;
  /** The unqualified key older stores used (`clashReviewKey(clash)`), for reading their decisions. */
  legacyKey: string;
  rule: string;
  ruleRevision: string;
  status: ClashStatus;
  severity: ClashSeverity;
  /** Signed: `<0` penetration depth, `>0` gap (m). */
  distance: number;
  distanceKind: ClashDistanceKind | null;
  /** Intersection volume (m³) when the host measured one. */
  volume: number | null;
  point: Vec3;
  /** Viewpoint-ready box around the clash, in the run's world frame (Y-up, metres). */
  bbox: { min: Vec3; max: Vec3 };
  a: ClashRunEndpoint;
  b: ClashRunEndpoint;
  /** The review state at the time the run was stored, when the host recorded one. */
  review?: ClashReview;
}

export interface ClashRunDocument {
  schema: typeof CLASH_RUN_DOCUMENT_SCHEMA_ID;
  version: typeof CLASH_RUN_DOCUMENT_VERSION;
  runId: string | null;
  createdAt: string;
  labels: string[];
  manifest: ClashRunManifest;
  findings: ClashRunFinding[];
}

/** How a runtime model id maps to a slot. Every model a clash references needs one. */
export interface ClashRunSlotBinding extends ClashRunSlot {
  /** The runtime `ClashElement.model` id loaded into this slot. */
  model: string;
}

export interface BuildClashRunDocumentInput {
  result: ClashResult;
  slots: readonly ClashRunSlotBinding[];
  engine?: { version?: string | null; build?: string | null; backend?: string | null };
  /** Host-pinned revisions by rule id, overriding `clashRuleRevision` (e.g. a saved rule-set version). */
  ruleRevisions?: Readonly<Record<string, string>>;
  labels?: readonly string[];
  runId?: string | null;
  /** ISO timestamp; defaults to now. */
  createdAt?: string;
  /** Measured intersection volumes by `Clash.id`. */
  volumes?: ReadonlyMap<string, number>;
  /** The exclusion set the engine ran with (`ClashSettings.exclusions`). Omitted: recorded as unknown. */
  exclusions?: ExclusionSet;
  /**
   * A durable description of each explicit-member rule's membership (e.g. the
   * saved filter definition), by rule id. Without one, the member lists
   * themselves are hashed, which are per-load refs: such a rule then compares
   * as changed on every reload, never as unchanged by mistake.
   */
  ruleMemberships?: Readonly<Record<string, string>>;
  /** Review state to record, by slot-qualified key. */
  reviews?: Readonly<Record<string, ClashReview>>;
}

/** Revision of a clash whose rule is missing from `rulesRun`: compares as a changed rule. */
const UNLISTED_RULE_REVISION = 'unlisted';

/** Slot-qualified, order-independent id of an excluded element pair. */
export function slotExclusionId(a: readonly [string, string], b: readonly [string, string]): string {
  const ea = JSON.stringify(a);
  const eb = JSON.stringify(b);
  return JSON.stringify(ea < eb ? [a, b] : [b, a]);
}

/** The semantic fields of a rule as it ran: what decides which pairs it reports. */
function ruleSemantics(rule: ClashRule, settings: ClashResult['settings']) {
  return {
    a: rule.a,
    b: rule.b ?? null,
    mode: rule.mode,
    tolerance: rule.tolerance ?? settings.tolerance,
    clearance: rule.mode === 'clearance' ? rule.clearance ?? null : null,
    reportTouch: rule.reportTouch === true,
    explicitMembers: { a: rule.membersA !== undefined, b: rule.membersB !== undefined },
    excludeVoidsAndHosts: settings.excludeVoidsAndHosts,
  };
}

/**
 * The semantic revision of a rule: changes when anything that decides which
 * pairs it reports changes (selectors, mode, tolerance, clearance, touch
 * reporting, void/host exclusion, explicit membership), and not for its name
 * or severity.
 *
 * Explicit member lists (`membersA`/`membersB`) are per-load refs, so a rule
 * that uses them should pass `membership`, a durable description of how its
 * members were chosen (the saved filter definition). Without it the lists
 * themselves are hashed: any membership change, and any reload, yields a new
 * revision, which fails closed (not comparable) instead of carrying a decision
 * across a membership change.
 */
export function clashRuleRevision(rule: ClashRule, settings: ClashResult['settings'], membership?: string): string {
  const explicit = rule.membersA !== undefined || rule.membersB !== undefined;
  const members = !explicit ? null : membership !== undefined ? { membership }
    : { a: rule.membersA ? [...rule.membersA].sort() : null, b: rule.membersB ? [...rule.membersB].sort() : null };
  return uuidFromSeed(`clash-rule/1 ${JSON.stringify({ ...ruleSemantics(rule, settings), members })}`);
}

function sortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const slot of [...map.keys()].sort()) out[slot] = [...map.get(slot)!].sort();
  return out;
}

/** Build the run document for a finished clash run. Throws when a clash's model has no slot. */
export function buildClashRunDocument(input: BuildClashRunDocumentInput): ClashRunDocument {
  const { result } = input;
  const slotByModel = new Map<string, string>();
  const slots = new Map<string, ClashRunSlot>();
  for (const binding of input.slots) {
    if (slotByModel.has(binding.model)) throw new Error(`model ${binding.model} is bound to more than one slot`);
    if (slots.has(binding.slot)) throw new Error(`slot ${binding.slot} is bound to more than one model`);
    slotByModel.set(binding.model, binding.slot);
    slots.set(binding.slot, {
      slot: binding.slot,
      sha256: binding.sha256,
      ...(binding.label !== undefined ? { label: binding.label } : {}),
      ...(binding.name !== undefined ? { name: binding.name } : {}),
    });
  }
  const slotOf = (model: string): string => {
    const slot = slotByModel.get(model);
    if (slot === undefined) throw new Error(`clash run references model ${model}, which is bound to no slot`);
    return slot;
  };

  // A key repeated by distinct objects within one slot has no identity that survives a re-run.
  const refsByKey = new Map<string, Set<number>>();
  const ambiguous = new Map<string, Set<string>>();
  const markAmbiguous = (slot: string, key: string) => {
    const set = ambiguous.get(slot) ?? new Set<string>();
    set.add(key);
    ambiguous.set(slot, set);
  };
  const observe = (model: string, key: string, ref: number, flagged: boolean) => {
    const slot = slotOf(model);
    if (flagged) markAmbiguous(slot, key);
    const id = JSON.stringify([slot, key]);
    const refs = refsByKey.get(id) ?? new Set<number>();
    refs.add(ref);
    refsByKey.set(id, refs);
    if (refs.size > 1) markAmbiguous(slot, key);
  };
  for (const clash of result.clashes) {
    observe(clash.a.model, clash.a.key, clash.a.ref, clash.a.keyAmbiguous === true);
    observe(clash.b.model, clash.b.key, clash.b.ref, clash.b.keyAmbiguous === true);
  }
  for (const coverage of result.ruleCoverage ?? []) {
    for (const element of coverage.matchedElements ?? []) observe(element.model, element.key, element.ref, false);
  }
  const isAmbiguous = (slot: string, key: string) => ambiguous.get(slot)?.has(key) === true;

  const revisions = new Map<string, string>();
  const rules: ClashRunRule[] = result.rulesRun.map((rule) => {
    const revision = input.ruleRevisions?.[rule.id] ?? clashRuleRevision(rule, result.settings, input.ruleMemberships?.[rule.id]);
    revisions.set(rule.id, revision);
    const { a, b, mode, tolerance, clearance, reportTouch, explicitMembers } = ruleSemantics(rule, result.settings);
    return { id: rule.id, name: rule.name, revision, a, b, mode, tolerance, clearance, reportTouch, explicitMembers };
  });
  const ruleSetRevision = uuidFromSeed(`clash-rule-set/1 ${JSON.stringify(rules.map((r) => [r.id, r.revision]).sort())}`);

  const coverage: ClashRunCoverage[] = (result.ruleCoverage ?? []).map((entry) => {
    let examined: Record<string, string[]> | null = null;
    if (entry.matchedElements) {
      const bySlot = new Map<string, Set<string>>();
      for (const element of entry.matchedElements) {
        const slot = slotOf(element.model);
        const set = bySlot.get(slot) ?? new Set<string>();
        set.add(element.key);
        bySlot.set(slot, set);
      }
      examined = sortedRecord(bySlot);
    }
    return { rule: entry.rule, matchedA: entry.matchedA, matchedB: entry.matchedB,
      candidatesExamined: entry.candidatesExamined ?? null, examined };
  });

  const endpoint = (ref: Clash['a']): ClashRunEndpoint => {
    const slot = slotOf(ref.model);
    return {
      slot,
      key: ref.key,
      globalId: bareIfcGuid(ref.key) || null,
      type: ref.tag,
      ...(ref.name !== undefined ? { name: ref.name } : {}),
      ...(isAmbiguous(slot, ref.key) ? { ambiguous: true as const } : {}),
    };
  };

  const findings = result.clashes.map((clash): ClashRunFinding => {
    // A clash always names a rule in `rulesRun`; a hand-built result that does not gets a revision no rule matches.
    const ruleRevision = revisions.get(clash.rule) ?? UNLISTED_RULE_REVISION;
    const a = endpoint(clash.a);
    const b = endpoint(clash.b);
    const key = a.ambiguous || b.ambiguous ? null : clashSlotReviewKey(clash, { slotOf, ruleRevision });
    const review = key !== null ? input.reviews?.[key] : undefined;
    return {
      id: clash.id,
      key,
      legacyKey: clashReviewKey(clash),
      rule: clash.rule,
      ruleRevision,
      status: clash.status,
      severity: clash.severity,
      distance: clash.distance,
      distanceKind: clash.distanceKind ?? null,
      volume: input.volumes?.get(clash.id) ?? null,
      point: [clash.point[0], clash.point[1], clash.point[2]],
      bbox: { min: [...clash.bounds.min], max: [...clash.bounds.max] },
      a,
      b,
      ...(review ? { review: { ...review } } : {}),
    };
  });

  return {
    schema: CLASH_RUN_DOCUMENT_SCHEMA_ID,
    version: CLASH_RUN_DOCUMENT_VERSION,
    runId: input.runId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    labels: [...new Set(input.labels ?? [])],
    manifest: {
      slots: [...slots.values()].sort((x, y) => (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0)),
      rules: { revision: ruleSetRevision, items: rules },
      engine: {
        name: '@ifc-lite/clash',
        version: input.engine?.version ?? null,
        build: input.engine?.build ?? null,
        backend: input.engine?.backend ?? null,
      },
      settings: { tolerance: result.settings.tolerance, excludeVoidsAndHosts: result.settings.excludeVoidsAndHosts },
      coverage,
      ambiguousKeys: sortedRecord(ambiguous),
      exclusions: input.exclusions ? recordExclusions(input.exclusions, slotByModel) : null,
      truncated: result.truncated ? { ...result.truncated } : null,
    },
    findings,
  };
}

/**
 * Translate an engine exclusion set to slot-qualified pair ids. A pair on a
 * model bound to no slot concerns no recorded finding and is dropped; a pair
 * that does not decode (built with another encoding) makes the record unknown,
 * since it could hide any pair.
 */
function recordExclusions(exclusions: ExclusionSet, slotByModel: ReadonlyMap<string, string>): string[] | null {
  const ids = new Set<string>();
  for (const pair of exclusions) {
    const decoded = decodeQualifiedPair(pair);
    if (!decoded) return null;
    const [a, b] = decoded;
    const slotA = slotByModel.get(a.model);
    const slotB = slotByModel.get(b.model);
    if (slotA !== undefined && slotB !== undefined) ids.add(slotExclusionId([slotA, a.key], [slotB, b.key]));
  }
  return [...ids].sort();
}
