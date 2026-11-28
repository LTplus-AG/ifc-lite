/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run documents a host reads back are untrusted (browser-submitted): the
 * validator must refuse an inconsistent one. Plus the exclusion semantics and
 * a scale guard on the comparison.
 */

import { describe, it, expect } from 'vitest';
import type { Clash, ClashElementRef, ClashResult, ClashRule } from './types.js';
import { slotPairKey } from './review.js';
import { buildClashRunDocument, type BuildClashRunDocumentInput, type ClashRunSlotBinding } from './run-document.js';
import { validateClashRunDocument } from './run-document-schema.js';
import { carryForwardReviews, compareClashRunDocuments } from './run-compare.js';

const RULE: ClashRule = { id: 'r', name: 'Ducts vs walls', a: 'IfcDuct*', b: 'IfcWall*', mode: 'hard' };
const SLOTS: ClashRunSlotBinding[] = [
  { slot: 'mep', model: 'm-mep', sha256: 'a'.repeat(64) },
  { slot: 'str', model: 'm-str', sha256: 'b'.repeat(64) },
];

/** One object per key: `D7` is ref 14, `W7` ref 15, in clashes and coverage alike (no accidental ambiguity). */
const refOf = (key: string) => Number(key.slice(1)) * 2 + (key.startsWith('W') ? 1 : 0);
const ref = (model: string, key: string, tag: string): ClashElementRef => ({ key, ref: refOf(key), model, tag });
const clash = (duct: string, wall: string): Clash => ({
  id: `r:${duct}:${wall}`, a: ref('m-mep', duct, 'IfcDuctSegment'), b: ref('m-str', wall, 'IfcWall'),
  rule: 'r', status: 'hard', distance: -0.01, distanceKind: 'estimate', point: [0, 0, 0],
  bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
});
function result(clashes: Clash[], ducts: string[], walls: string[], settings = { tolerance: 0.002, excludeVoidsAndHosts: true }): ClashResult {
  const matchedElements = [
    ...ducts.map((key) => ({ model: 'm-mep', key, ref: refOf(key) })),
    ...walls.map((key) => ({ model: 'm-str', key, ref: refOf(key) })),
  ];
  return {
    clashes,
    summary: { total: clashes.length, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: clashes.length, minor: 0, info: 0 } },
    rulesRun: [RULE],
    ruleCoverage: [{ rule: 'r', matchedA: ducts.length, matchedB: walls.length, matchedElements,
      matchedKeysA: [...ducts].sort(), matchedKeysB: [...walls].sort() }],
    settings,
  };
}
const build = (input: Omit<BuildClashRunDocumentInput, 'slots'>) =>
  buildClashRunDocument({ slots: SLOTS, exclusions: new Set(), exclusionRules: [], createdAt: '2026-11-28T10:00:00.000Z', ...input });
const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('validateClashRunDocument: consistency of an untrusted document', () => {
  it("refuses a finding whose key names another pair, a stale rule revision and a duplicate id (the reviewer's repro)", () => {
    const previous = build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) });
    const decisionKey = previous.findings[0].key!;
    // A forged next run: a finding on D2/W2 carrying D1/W1's key, a stale revision, and a repeated id.
    const next = roundTrip(build({ result: result([clash('D2', 'W2'), clash('D3', 'W3')], ['D2', 'D3'], ['W2', 'W3']) }));
    next.findings[0].key = slotPairKey('r', previous.findings[0].ruleRevision, ['mep', 'D1'], ['str', 'W1']);
    next.findings[1].ruleRevision = 'stale-rev';
    next.findings[1].id = next.findings[0].id;
    const res = validateClashRunDocument(next);
    expect(res.ok).toBe(false);
    expect(res.ok ? [] : res.errors).toEqual(expect.arrayContaining([
      "$.findings[0].key: does not follow from the finding's elements and rule",
      `$.findings[1].id: duplicate finding id ${JSON.stringify(next.findings[0].id)}`,
      "$.findings[1].ruleRevision: does not match the manifest rule's revision",
    ]));
    // What the forgery would have done had a host skipped validation: carry D1/W1's decision onto D2/W2.
    const carried = carryForwardReviews(previous, next, { [decisionKey]: { status: 'accepted' } });
    expect(carried.carried.map((c) => c.to)).toEqual([decisionKey]);
  });

  it('checks the legacy key of an ambiguous finding by structure, since its ref is not stored', () => {
    const repeated = result([clash('D1', 'W1'), { ...clash('D1', 'W1'), id: 'r:D1:W1:dup', a: { ...clash('D1', 'W1').a, ref: 99, keyAmbiguous: true } }],
      ['D1'], ['W1']);
    const doc = roundTrip(build({ result: repeated }));
    expect(doc.findings.every((f) => f.key === null)).toBe(true);
    expect(validateClashRunDocument(doc).ok).toBe(true);
    doc.findings[1].legacyKey = 'r D9 W9';
    const res = validateClashRunDocument(doc);
    expect(res.ok ? [] : res.errors).toEqual(["$.findings[1].legacyKey: does not follow from the finding's elements and rule"]);
  });

  it('refuses unknown properties, a forged legacy key, a coverage rule and a rule-set revision that do not match', () => {
    const doc = roundTrip(build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) }));
    expect(validateClashRunDocument(doc).ok).toBe(true);
    const bad = roundTrip(doc);
    (bad.findings[0] as unknown as Record<string, unknown>).review = { status: 'open', coment: 'typo' };
    (bad.findings[0].a as unknown as Record<string, unknown>).ambigous = true;
    bad.findings[0].legacyKey = 'r OTHER W1';
    bad.manifest.coverage[0].rule = 'ghost';
    bad.manifest.rules.revision = 'tampered';
    const res = validateClashRunDocument(bad);
    expect(res.ok ? [] : res.errors).toEqual(expect.arrayContaining([
      '$.findings[0].review."coment": unknown property',
      '$.findings[0].a."ambigous": unknown property',
    ]));
    delete (bad.findings[0] as unknown as Record<string, unknown>).review;
    delete (bad.findings[0].a as unknown as Record<string, unknown>).ambigous;
    const semantic = validateClashRunDocument(bad);
    expect(semantic.ok ? [] : semantic.errors).toEqual([
      '$.manifest.rules.revision: does not match the listed rules and revisions',
      '$.manifest.coverage[0].rule: not in manifest.rules',
      "$.findings[0].legacyKey: does not follow from the finding's elements and rule",
    ]);
  });
});

describe('validator and coverage edge cases', () => {
  it('names shape and consistency errors in one pass', () => {
    const doc = roundTrip(build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) }));
    doc.manifest.slots[0].sha256 = 'not-a-sha';
    doc.findings[0].a.slot = 'ghost';
    const res = validateClashRunDocument(doc);
    expect(res.ok ? [] : res.errors).toEqual(expect.arrayContaining([
      '$.manifest.slots[0].sha256: expected a lowercase hex sha256 or null',
      '$.findings[0].a.slot: not in manifest.slots',
    ]));
    // Malformed enough that consistency cannot run: still a refusal with the shape error, never a throw.
    const broken = validateClashRunDocument({ ...doc, findings: 'nope' });
    expect(broken.ok ? [] : broken.errors).toContain('$.findings: expected an array');
  });

  it('does not call a pair added when the previous run recorded no coverage', () => {
    const blind = result([], ['D1'], ['W1']);
    delete blind.ruleCoverage;
    const previous = build({ result: blind });
    const next = build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) });
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.added).toEqual([]);
    expect(cmp.notComparable.map((e) => [e.side, e.reasons])).toEqual([['next', ['coverage-not-recorded']]]);
  });

  it('treats a two-sided rule without side-B keys as unrecorded coverage, not a self-clash', () => {
    const previous = build({ result: result([clash('D1', 'W1')], ['D1', 'W1'], ['W1']) });
    const partial = result([], ['D1', 'W1'], ['W1']);
    delete partial.ruleCoverage![0].matchedKeysB;
    const next = build({ result: partial });
    expect(next.manifest.coverage[0].examined).toBeNull();
    expect(compareClashRunDocuments(previous, next).notComparable.map((e) => e.reasons)).toEqual([['coverage-not-recorded']]);
  });
});

describe('host-supplied input', () => {
  it('reads per-rule records by own property, so a rule id __proto__ keeps its own membership', () => {
    const protoRule: ClashRule = { ...RULE, id: '__proto__', membersA: ['m-mep:0'] };
    const r: ClashResult = { ...result([], ['D1'], ['W1']), rulesRun: [protoRule], ruleCoverage: [] };
    const revision = (membership: string) => build({ result: r,
      ruleMemberships: Object.fromEntries([['__proto__', membership]]) }).manifest.rules.items[0].revision;
    expect(revision('filter: walls')).not.toBe(revision('filter: slabs'));
    // No record at all: hashed from the member lists, not from Object.prototype.
    expect(build({ result: r }).manifest.rules.items[0].revision).not.toBe(revision('filter: walls'));
  });

  it('stores a sha256 as lowercase hex and refuses one that is not a SHA-256', () => {
    const r = result([], ['D1'], ['W1']);
    const doc = buildClashRunDocument({ result: r, exclusions: new Set(),
      slots: [{ ...SLOTS[0], sha256: 'A'.repeat(64) }, SLOTS[1]] });
    expect(doc.manifest.slots[0].sha256).toBe('a'.repeat(64));
    expect(validateClashRunDocument(roundTrip(doc)).ok).toBe(true);
    expect(() => buildClashRunDocument({ result: r, slots: [{ ...SLOTS[0], sha256: 'not-a-sha' }, SLOTS[1]] }))
      .toThrow(/not a hex SHA-256/);
  });

  it('refuses an unlisted rule or unslotted model even when a user rule would filter that clash out', () => {
    const stray: Clash = { ...clash('D1', 'W1'), rule: 'not-run' };
    expect(() => build({ result: result([stray], ['D1'], ['W1']), exclusionRules: [{ kind: 'type', type: 'IfcWall' }] }))
      .toThrow(/not in rulesRun/);
    const unslotted: Clash = { ...clash('D1', 'W1'), b: { ...clash('D1', 'W1').b, model: 'm-elsewhere' } };
    expect(() => build({ result: result([unslotted], ['D1'], ['W1']), exclusionRules: [{ kind: 'type', type: 'IfcWall' }] }))
      .toThrow(/bound to no slot/);
  });
});

describe('type exclusions and rule forms across runs', () => {
  it("judges each run's type rules by the types that run recorded, not the finding's", () => {
    const previous = build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) });
    // Next version: W1 keeps its GlobalId but is now an IfcBeam, and the user excludes beams.
    const asBeam = (c: Clash): Clash => ({ ...c, b: { ...c.b, tag: 'IfcBeam' } });
    const nextResult = result([asBeam(clash('D1', 'W1'))], ['D1'], ['W1']);
    const elementTypes = [{ model: 'm-mep', key: 'D1', tag: 'IfcDuctSegment' }, { model: 'm-str', key: 'W1', tag: 'IfcBeam' }];
    const next = build({ result: nextResult, exclusionRules: [{ kind: 'type', type: 'IfcBeam' }], elementTypes });
    expect(next.findings).toEqual([]);
    expect(next.manifest.exclusionTypes).toEqual({ str: { W1: 'IfcBeam' } });
    expect(compareClashRunDocuments(previous, next).notComparable.map((e) => e.reasons)).toEqual([['excluded-in-other-run']]);
    // And without the element types, nothing can be cleared against a type rule.
    const blind = build({ result: nextResult, exclusionRules: [{ kind: 'type', type: 'IfcBeam' }] });
    expect(blind.manifest.exclusionTypes).toBeNull();
    expect(compareClashRunDocuments(previous, blind).notComparable.map((e) => e.reasons)).toEqual([['exclusions-not-recorded']]);
  });

  it('allows one coverage entry per rule, in the builder and the validator', () => {
    const twice = result([], ['D1'], ['W1']);
    twice.ruleCoverage = [...twice.ruleCoverage!, { ...twice.ruleCoverage![0], matchedKeysA: [] }];
    expect(() => build({ result: twice })).toThrow(/more than one coverage entry/);
    const doc = roundTrip(build({ result: result([], ['D1'], ['W1']) }));
    doc.manifest.coverage.push({ ...doc.manifest.coverage[0] });
    const res = validateClashRunDocument(doc);
    expect(res.ok ? [] : res.errors).toEqual(['$.manifest.coverage[1].rule: duplicate coverage entry for "r"']);
  });

  it('records explicit membership from the rules as given, and refuses one-sided coverage for a two-sided rule', () => {
    const given: ClashRule = { ...RULE, membersA: ['m-mep:2'] };
    const doc = build({ result: result([], ['D1'], ['W1']), rules: [given], ruleMemberships: { r: 'filter: ducts' } });
    expect(doc.manifest.rules.items[0].explicitMembers).toEqual({ a: true, b: false });
    const bad = roundTrip(build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) }));
    bad.manifest.coverage[0].examined!.b = null;
    const res = validateClashRunDocument(bad);
    expect(res.ok ? [] : res.errors).toEqual(['$.manifest.coverage[0].examined.b: must be recorded for a two-sided rule']);
  });
});

describe('exclusions in run documents', () => {
  it('leaves out findings a user rule covers, and never reports them as added or persistent', () => {
    const both = result([clash('D1', 'W1'), clash('D2', 'W2')], ['D1', 'D2'], ['W1', 'W2']);
    const previous = build({ result: both });
    const next = build({ result: both, exclusionRules: [{ kind: 'elementKeyPair', a: 'W2', b: 'D2' }] });
    expect(next.findings.map((f) => f.a.key)).toEqual(['D1']);
    expect(validateClashRunDocument(roundTrip(next)).ok).toBe(true);
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.persistent.map((p) => p.next.a.key)).toEqual(['D1']);
    expect(cmp.noLongerDetected).toEqual([]);
    expect(cmp.notComparable.map((e) => [e.side, e.finding.a.key, e.reasons])).toEqual([['previous', 'D2', ['excluded-in-other-run']]]);
    // Reversed: lifting the exclusion makes D2 reappear, which is not "added".
    const back = compareClashRunDocuments(next, previous);
    expect(back.added).toEqual([]);
    expect(back.notComparable.map((e) => [e.side, e.finding.a.key, e.reasons])).toEqual([['next', 'D2', ['excluded-in-other-run']]]);
  });

  it('records omitted user rules as unknown, so a pair the host filtered out is not called fixed', () => {
    const previous = build({ result: result([clash('D1', 'W1')], ['D1'], ['W1']) });
    // A host that applied its own user rules to the result and did not pass them.
    const filtered = buildClashRunDocument({ result: result([], ['D1'], ['W1']), slots: SLOTS, exclusions: new Set() });
    expect(filtered.manifest.exclusionRules).toBeNull();
    expect(validateClashRunDocument(roundTrip(filtered)).ok).toBe(true);
    expect(compareClashRunDocuments(previous, filtered).notComparable.map((e) => e.reasons)).toEqual([['exclusions-not-recorded']]);
  });

  it('covers type and type-pair rules', () => {
    const r = result([clash('D1', 'W1')], ['D1'], ['W1']);
    expect(build({ result: r, exclusionRules: [{ kind: 'type', type: 'IfcWall' }] }).findings).toEqual([]);
    expect(build({ result: r, exclusionRules: [{ kind: 'typePair', a: 'IfcWall', b: 'IfcDuctSegment' }] }).findings).toEqual([]);
    expect(build({ result: r, exclusionRules: [{ kind: 'typePair', a: 'IfcWall', b: 'IfcBeam' }] }).findings).toHaveLength(1);
  });

  it('records no engine exclusions when excludeVoidsAndHosts was off, since the engine applied none', () => {
    const off = result([], ['D1'], ['W1'], { tolerance: 0.002, excludeVoidsAndHosts: false });
    const doc = build({ result: off, exclusions: new Set(['ignored-when-off']) });
    expect(doc.manifest.exclusions).toEqual([]);
  });
});

describe('compareClashRunDocuments at scale', () => {
  it('compares 100k findings in linear time', () => {
    const n = 100_000;
    const ducts = Array.from({ length: n }, (_, i) => `D${i}`);
    const walls = Array.from({ length: n }, (_, i) => `W${i}`);
    const pairs = (from: number, to: number) => ducts.slice(from, to).map((d, i) => clash(d, walls[from + i]));
    const exclusions = new Set<string>();
    const previous = build({ result: result(pairs(0, n), ducts, walls), exclusions });
    // Half are gone (each needs the coverage check), half persist.
    const next = build({ result: result(pairs(n / 2, n), ducts, walls), exclusions });
    const started = performance.now();
    const cmp = compareClashRunDocuments(previous, next);
    const elapsed = performance.now() - started;
    expect(cmp.summary).toEqual({ added: 0, persistent: n / 2, noLongerDetected: n / 2, notComparable: 0 });
    // The quadratic version took ~56 s here; linear is well under a second. Generous for slow CI.
    expect(elapsed).toBeLessThan(10_000);
  }, 120_000);
});
