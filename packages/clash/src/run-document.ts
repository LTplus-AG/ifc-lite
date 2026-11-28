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
import { clashElementIdentity } from './object-identity.js';
import { clashReviewKey, clashSlotReviewKey } from './review.js';
import { exclusionRuleCovers, recordExclusions, type ClashRunExclusionRule } from './run-exclusions.js';
import type { Clash, ClashDistanceKind, ExclusionSet, ClashResult, ClashReview, ClashRule, ClashSeverity, ClashStatus, Vec3 } from './types.js';

export { matchesExclusionRule, slotExclusionId, type ClashRunExclusionRule } from './run-exclusions.js';

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
  /**
   * Durable keys this rule matched on each side, per slot, sorted. `b` is
   * `null` for a self-clash rule. `null` as a whole: the engine did not record
   * per-side matches, so no absence can be verified against this run.
   *
   * A key that matched on BOTH sides and occurs in more than one slot is left
   * out of both: the engine records sides by key only, so which slot's element
   * sat on which side is unknown, and an unknown side must not read as tested.
   */
  examined: { a: Record<string, string[]>; b: Record<string, string[]> | null } | null;
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
   * Element pairs the engine skipped (`ClashSettings.exclusions`: voids/hosts,
   * aggregates), as `slotExclusionId`s, sorted. `[]` when
   * `excludeVoidsAndHosts` was off, since the engine then applies none.
   * `null`: not recorded, so the absence of a finding cannot be told apart
   * from an exclusion.
   */
  exclusions: string[] | null;
  /**
   * The user's enabled exclusion rules. Findings they cover are left out of
   * `findings`, and a comparison treats a pair they cover as excluded in this
   * run, so a pair the user excluded is never reported as added, persistent
   * or no longer detected.
   */
  exclusionRules: ClashRunExclusionRule[];
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
  /** The user's enabled exclusion rules; findings they cover are left out of the document. */
  exclusionRules?: readonly ClashRunExclusionRule[];
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

/** The revision of a whole rule set: changes when any rule is added, removed or changes revision. */
export function clashRuleSetRevision(rules: ReadonlyArray<Pick<ClashRunRule, 'id' | 'revision'>>): string {
  return uuidFromSeed(`clash-rule-set/1 ${JSON.stringify(rules.map((r) => [r.id, r.revision]).sort())}`);
}

/** An OWN entry of a host-supplied record: a rule id like `__proto__` must not read the prototype. */
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** A slot's sha256 as the document stores it: lowercase hex, or null. Anything else is refused, not passed on. */
function pinnedSha256(binding: ClashRunSlotBinding): string | null {
  if (binding.sha256 === null) return null;
  const sha = binding.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`slot ${binding.slot} has sha256 ${JSON.stringify(binding.sha256)}, which is not a hex SHA-256`);
  return sha;
}

/** Own data properties only (`Object.fromEntries`), so a slot id such as `__proto__` survives. */
function sortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...map.keys()].sort().map((slot) => [slot, [...map.get(slot)!].sort()]));
}

/** Build the run document for a finished clash run. Throws when a clash's model has no slot or its rule is not in `rulesRun`. */
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
      sha256: pinnedSha256(binding),
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
    const revision = own(input.ruleRevisions, rule.id) ?? clashRuleRevision(rule, result.settings, own(input.ruleMemberships, rule.id));
    revisions.set(rule.id, revision);
    const { a, b, mode, tolerance, clearance, reportTouch, explicitMembers } = ruleSemantics(rule, result.settings);
    return { id: rule.id, name: rule.name, revision, a, b, mode, tolerance, clearance, reportTouch, explicitMembers };
  });
  const ruleSetRevision = clashRuleSetRevision(rules);

  const coverage: ClashRunCoverage[] = (result.ruleCoverage ?? []).map((entry) => {
    let examined: ClashRunCoverage['examined'] = null;
    // A two-sided rule (matchedB not null) needs its side-B keys too; without them it is unknown, not a self-clash.
    const sidesRecorded = entry.matchedKeysA !== undefined && (entry.matchedB === null || Array.isArray(entry.matchedKeysB));
    if (entry.matchedElements && entry.matchedKeysA && sidesRecorded) {
      const keysA = new Set(entry.matchedKeysA);
      const keysB = entry.matchedKeysB ? new Set(entry.matchedKeysB) : null;
      const slotsOfKey = new Map<string, Set<string>>();
      for (const element of entry.matchedElements) {
        const slots = slotsOfKey.get(element.key) ?? new Set<string>();
        slots.add(slotOf(element.model));
        slotsOfKey.set(element.key, slots);
      }
      const sideA = new Map<string, Set<string>>();
      const sideB = new Map<string, Set<string>>();
      const add = (side: Map<string, Set<string>>, slot: string, key: string) => {
        const set = side.get(slot) ?? new Set<string>();
        set.add(key);
        side.set(slot, set);
      };
      for (const [key, slots] of slotsOfKey) {
        const inA = keysA.has(key);
        const inB = keysB?.has(key) === true;
        if (inA && inB && slots.size > 1) continue; // side per slot unknown: credit neither
        for (const slot of slots) {
          if (inA) add(sideA, slot, key);
          if (inB) add(sideB, slot, key);
        }
      }
      examined = { a: sortedRecord(sideA), b: keysB ? sortedRecord(sideB) : null };
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

  const exclusionRules = (input.exclusionRules ?? []).map((rule) => ({ ...rule }));
  const userExcluded = (clash: Clash) => exclusionRules.some((rule) => exclusionRuleCovers(rule,
    { type: clash.a.tag, identity: clashElementIdentity(clash.a) }, { type: clash.b.tag, identity: clashElementIdentity(clash.b) }));
  // Refuse unslotted models and unlisted rules on EVERY clash, before user rules filter any out:
  // what the run produced is the input, not what happens to survive the filter.
  for (const clash of result.clashes) {
    slotOf(clash.a.model);
    slotOf(clash.b.model);
    if (!revisions.has(clash.rule)) throw new Error(`clash run references rule ${clash.rule}, which is not in rulesRun`);
  }
  const findings = result.clashes.filter((clash) => !userExcluded(clash)).map((clash): ClashRunFinding => {
    // Without the rule in `rulesRun` its semantics are unrecorded, so no key could be trusted to compare.
    const ruleRevision = revisions.get(clash.rule);
    if (ruleRevision === undefined) throw new Error(`clash run references rule ${clash.rule}, which is not in rulesRun`);
    const a = endpoint(clash.a);
    const b = endpoint(clash.b);
    const key = a.ambiguous || b.ambiguous ? null : clashSlotReviewKey(clash, { slotOf, ruleRevision });
    const review = key !== null ? own(input.reviews, key) : undefined;
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
      // The engine applies `exclusions` only with `excludeVoidsAndHosts` on (orchestrator), so off means none.
      exclusions: !result.settings.excludeVoidsAndHosts ? [] : input.exclusions ? recordExclusions(input.exclusions, slotByModel) : null,
      exclusionRules,
      truncated: result.truncated ? { ...result.truncated } : null,
    },
    findings,
  };
}
