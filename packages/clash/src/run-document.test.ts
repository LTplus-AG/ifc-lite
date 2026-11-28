/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { Clash, ClashElementRef, ClashResult, ClashRule } from './types.js';
import { clashReviewKey, clashSlotReviewKey, parseClashReviewKey } from './review.js';
import { makeExclusionSet, qualifiedKey } from './exclude.js';
import {
  buildClashRunDocument as buildWithoutDefaults,
  clashRuleRevision,
  type BuildClashRunDocumentInput,
  CLASH_RUN_BROWSER_SUBMITTED,
  type ClashRunSlotBinding,
} from './run-document.js';
import { CLASH_RUN_DOCUMENT_JSON_SCHEMA, validateClashRunDocument } from './run-document-schema.js';
import { carryForwardReviews, compareClashRunDocuments } from './run-compare.js';

const GUID_DUCT = '2O2Fr$t4X7Zf8NOew3FLOH';
const GUID_WALL = '0K7w7JN4X3Ae9wq8z_zF2v';
const GUID_BEAM = '1hOSvn6df7F8_7GcBWlRGQ';
const SHA_A1 = 'a'.repeat(64);
const SHA_A2 = 'b'.repeat(64);
const SHA_S1 = 'c'.repeat(64);

const RULE: ClashRule = { id: 'mep-str', name: 'MEP vs Structure', a: 'IfcDuct*', b: 'IfcWall*', mode: 'hard' };
const SETTINGS = { tolerance: 0.002, excludeVoidsAndHosts: true };

function ref(model: string, key: string, refNo: number, tag = 'IfcWall', extra: Partial<ClashElementRef> = {}): ClashElementRef {
  return { key, ref: refNo, model, tag, ...extra };
}

function clash(a: ClashElementRef, b: ClashElementRef, rule = RULE.id): Clash {
  return {
    id: `${rule}:${a.model}/${a.key}:${b.model}/${b.key}:${a.ref}`,
    a, b, rule, status: 'hard', distance: -0.05, distanceKind: 'estimate',
    point: [1, 2, 3], bounds: { min: [0, 1, 2], max: [2, 3, 4] }, severity: 'major',
  };
}

function result(clashes: Clash[], rules: ClashRule[] = [RULE], matched?: Array<{ model: string; key: string; ref: number }>): ClashResult {
  return {
    clashes,
    summary: { total: clashes.length, byRule: {}, byTypePair: {}, bySeverity: { critical: 0, major: 0, minor: 0, info: 0 } },
    rulesRun: rules,
    // Fixture coverage: every matched element sits on both sides of every rule.
    ruleCoverage: rules.map((r) => {
      const keys = matched ? [...new Set(matched.map((m) => m.key))].sort() : undefined;
      return { rule: r.id, matchedA: 1, matchedB: 1,
        ...(matched ? { matchedElements: matched, matchedKeysA: keys, matchedKeysB: keys } : {}) };
    }),
    settings: SETTINGS,
  };
}

const slots = (archSha: string | null, structSha: string | null, archModel = 'load-1', structModel = 'load-2'): ClashRunSlotBinding[] => [
  { slot: 'arch', model: archModel, sha256: archSha, label: 'Architecture' },
  { slot: 'struct', model: structModel, sha256: structSha },
];

/** The fixtures here apply no exclusions, and say so. */
const buildClashRunDocument = (input: BuildClashRunDocumentInput) => buildWithoutDefaults({ exclusions: new Set(), ...input });

const slotMap = (table: Record<string, string>) => (model: string): string | undefined => table[model];

describe('slot-qualified clashReviewKey', () => {
  const revision = clashRuleRevision(RULE, SETTINGS);

  it('keeps the legacy key unchanged without options', () => {
    const c = clash(ref('m1', GUID_DUCT, 1, 'IfcDuctSegment'), ref('m1', GUID_WALL, 2));
    // Sorted: the wall's GlobalId orders first.
    expect(clashReviewKey(c)).toBe(`mep-str ${GUID_WALL} ${GUID_DUCT}`);
    expect(parseClashReviewKey(clashReviewKey(c))).toEqual({ format: 'legacy', rule: 'mep-str', a: GUID_WALL, b: GUID_DUCT });
    // Callers hand it straight to Array.prototype.map, which passes the index as a second argument.
    const other = clash(ref('m1', GUID_BEAM, 3), ref('m1', GUID_WALL, 2));
    expect([c, other].map(clashReviewKey)).toEqual([clashReviewKey(c), clashReviewKey(other)]);
  });

  it('hashes explicit membership unless a durable description is given', () => {
    const members: ClashRule = { ...RULE, membersA: ['m:1'] };
    const wider: ClashRule = { ...RULE, membersA: ['m:1', 'm:2'] };
    expect(clashRuleRevision(members, SETTINGS)).not.toBe(clashRuleRevision(wider, SETTINGS));
    expect(clashRuleRevision(members, SETTINGS)).not.toBe(revision);
    // A durable filter description replaces the per-load lists.
    expect(clashRuleRevision(members, SETTINGS, 'filter:walls')).toBe(clashRuleRevision(wider, SETTINGS, 'filter:walls'));
    expect(clashRuleRevision(members, SETTINGS, 'filter:walls')).not.toBe(clashRuleRevision(members, SETTINGS, 'filter:slabs'));
  });

  it('separates the same model opened in two slots', () => {
    // One file loaded twice (e.g. a reference copy in a second slot): identical GlobalIds,
    // so the legacy key collides, the slot key does not.
    const slotOf = slotMap({ first: 's1', second: 's2', mep: 'mep' });
    const inFirst = clash(ref('mep', GUID_DUCT, 1), ref('first', GUID_WALL, 10));
    const inSecond = clash(ref('mep', GUID_DUCT, 1), ref('second', GUID_WALL, 20));
    expect(clashReviewKey(inFirst)).toBe(clashReviewKey(inSecond));
    const k1 = clashSlotReviewKey(inFirst, { slotOf, ruleRevision: revision });
    const k2 = clashSlotReviewKey(inSecond, { slotOf, ruleRevision: revision });
    expect(k1).not.toBeNull();
    expect(k1).not.toBe(k2);
    expect(parseClashReviewKey(k1!)).toMatchObject({ format: 'slot', rule: 'mep-str', ruleRevision: revision });
  });

  it('is order-independent and survives a new per-load model id in the same slot', () => {
    const before = clash(ref('load-1', GUID_DUCT, 1), ref('load-2', GUID_WALL, 2));
    const after = clash(ref('load-9', GUID_WALL, 7), ref('load-8', GUID_DUCT, 5));
    const k1 = clashSlotReviewKey(before, { slotOf: slotMap({ 'load-1': 'mep', 'load-2': 'arch' }), ruleRevision: revision });
    const k2 = clashSlotReviewKey(after, { slotOf: slotMap({ 'load-8': 'mep', 'load-9': 'arch' }), ruleRevision: revision });
    expect(k1).toBe(k2);
  });

  it('changes when a rule keeps its id but changes its semantics', () => {
    const changed: ClashRule = { ...RULE, b: 'IfcWall*|IfcSlab*' };
    expect(clashRuleRevision(changed, SETTINGS)).not.toBe(revision);
    expect(clashRuleRevision({ ...RULE, name: 'Renamed', severity: 'critical' }, SETTINGS)).toBe(revision);
    expect(clashRuleRevision(RULE, { ...SETTINGS, tolerance: 0.01 })).not.toBe(revision);
    const c = clash(ref('a', GUID_DUCT, 1), ref('b', GUID_WALL, 2));
    const slotOf = (m: string) => m;
    expect(clashSlotReviewKey(c, { slotOf, ruleRevision: revision }))
      .not.toBe(clashSlotReviewKey(c, { slotOf, ruleRevision: clashRuleRevision(changed, SETTINGS) }));
  });

  it('gives a GlobalId duplicated within a slot no key', () => {
    const c = clash(ref('a', GUID_DUCT, 1), ref('b', GUID_WALL, 2, 'IfcWall', { keyAmbiguous: true }));
    expect(clashSlotReviewKey(c, { slotOf: (m) => m, ruleRevision: revision })).toBeNull();
    expect(clashSlotReviewKey(c, { slotOf: () => undefined, ruleRevision: revision })).toBeNull();
  });

  it('rejects unreadable keys', () => {
    expect(parseClashReviewKey('@not json')).toBeNull();
    expect(parseClashReviewKey('only two')).toBeNull();
    expect(parseClashReviewKey('@["r","a","b"]')).toEqual({ format: 'legacy', rule: 'r', a: 'a', b: 'b' });
  });
});

describe('buildClashRunDocument', () => {
  const run = () => buildClashRunDocument({
    result: result([clash(ref('load-1', GUID_WALL, 2), ref('load-2', GUID_BEAM, 3, 'IfcBeam'))]),
    slots: slots(SHA_A1, SHA_S1),
    engine: { version: '3.0.1', build: 'abc123', backend: 'ts' },
    labels: [CLASH_RUN_BROWSER_SUBMITTED, CLASH_RUN_BROWSER_SUBMITTED],
    createdAt: '2026-11-28T10:00:00.000Z',
  });

  it('records the manifest and slot-qualified findings', () => {
    const doc = run();
    expect(doc.labels).toEqual(['browser-submitted']);
    expect(doc.manifest.slots).toEqual([{ slot: 'arch', sha256: SHA_A1, label: 'Architecture' }, { slot: 'struct', sha256: SHA_S1 }]);
    expect(doc.manifest.rules.items[0]).toMatchObject({ id: 'mep-str', revision: clashRuleRevision(RULE, SETTINGS), tolerance: 0.002 });
    expect(doc.manifest.engine).toEqual({ name: '@ifc-lite/clash', version: '3.0.1', build: 'abc123', backend: 'ts' });
    const [finding] = doc.findings;
    expect(finding.a).toEqual({ slot: 'arch', key: GUID_WALL, globalId: GUID_WALL, type: 'IfcWall' });
    expect(finding.b.type).toBe('IfcBeam');
    expect(finding.bbox).toEqual({ min: [0, 1, 2], max: [2, 3, 4] });
    expect(parseClashReviewKey(finding.key!)).toMatchObject({ format: 'slot' });
    expect(finding.legacyKey).toBe(`mep-str ${GUID_WALL} ${GUID_BEAM}`);
  });

  it('survives a JSON round trip and validates', () => {
    const doc = JSON.parse(JSON.stringify(run()));
    expect(validateClashRunDocument(doc)).toEqual({ ok: true, document: doc });
  });

  it('names every failing path', () => {
    const doc = JSON.parse(JSON.stringify(run()));
    doc.manifest.slots[0].sha256 = 'not-a-sha';
    doc.findings[0].a.slot = 'ghost';
    delete doc.findings[0].bbox;
    const res = validateClashRunDocument(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toEqual(expect.arrayContaining([
      '$.manifest.slots[0].sha256: expected a lowercase hex sha256 or null',
      '$.findings[0].bbox: missing',
    ]));
    doc.manifest.slots[0].sha256 = SHA_A1;
    doc.findings[0].bbox = { min: [0, 0, 0], max: [1, 1, 1] };
    const second = validateClashRunDocument(doc);
    expect(second.ok ? [] : second.errors).toEqual([
      '$.findings[0].a.slot: not in manifest.slots',
      "$.findings[0].key: does not follow from the finding's elements and rule",
    ]);
    expect(validateClashRunDocument({ schema: 'x' }).ok).toBe(false);
  });

  it('has a schema whose required fields the builder fills', () => {
    const doc = run();
    expect(Object.keys(doc).sort()).toEqual([...CLASH_RUN_DOCUMENT_JSON_SCHEMA.required].sort());
    expect(Object.keys(doc.manifest).sort()).toEqual([...CLASH_RUN_DOCUMENT_JSON_SCHEMA.properties.manifest.required].sort());
    const findingRequired = CLASH_RUN_DOCUMENT_JSON_SCHEMA.properties.findings.items.required;
    for (const field of findingRequired) expect(Object.hasOwn(doc.findings[0], field)).toBe(true);
  });

  it('marks a GlobalId repeated within a slot as ambiguous', () => {
    const doc = buildClashRunDocument({
      result: result([
        clash(ref('load-1', GUID_WALL, 2), ref('load-2', GUID_BEAM, 3)),
        clash(ref('load-1', GUID_WALL, 9), ref('load-2', GUID_BEAM, 3)),
      ]),
      slots: slots(SHA_A1, SHA_S1),
    });
    expect(doc.findings.map((f) => f.key)).toEqual([null, null]);
    expect(doc.findings[0].a.ambiguous).toBe(true);
    expect(doc.manifest.ambiguousKeys).toEqual({ arch: [GUID_WALL] });
  });

  it('accepts only RFC 3339 date-times, as the schema does', () => {
    for (const createdAt of ['2026-11-28', '1', '2026-11-28T10:00:00', '2026-02-31T10:00:00Z']) {
      const doc = { ...JSON.parse(JSON.stringify(run())), createdAt };
      expect(validateClashRunDocument(doc).ok, createdAt).toBe(false);
    }
    expect(validateClashRunDocument({ ...JSON.parse(JSON.stringify(run())), createdAt: '2026-11-28T10:00:00+01:00' }).ok).toBe(true);
  });

  it('keeps a slot named __proto__ as an own, serialised record', () => {
    const doc = buildClashRunDocument({
      result: result([clash(ref('load-1', GUID_WALL, 2), ref('load-1', GUID_WALL, 9))], [RULE],
        [{ model: 'load-1', key: GUID_WALL, ref: 2 }]),
      slots: [{ slot: '__proto__', model: 'load-1', sha256: null }],
    });
    const stored = JSON.parse(JSON.stringify(doc));
    expect(stored.manifest.ambiguousKeys).toEqual(JSON.parse(`{"__proto__":["${GUID_WALL}"]}`));
    expect(Object.hasOwn(stored.manifest.coverage[0].examined.a, '__proto__')).toBe(true);
    expect(validateClashRunDocument(stored).ok).toBe(true);
  });

  it('refuses a clash whose rule is not in rulesRun', () => {
    expect(() => buildClashRunDocument({
      result: result([clash(ref('load-1', GUID_WALL, 2), ref('load-2', GUID_BEAM, 3))], []),
      slots: slots(SHA_A1, SHA_S1),
    })).toThrow(/not in rulesRun/);
  });

  it('refuses a clash on a model bound to no slot', () => {
    expect(() => buildClashRunDocument({
      result: result([clash(ref('stray', GUID_WALL, 2), ref('load-2', GUID_BEAM, 3))]),
      slots: slots(SHA_A1, SHA_S1),
    })).toThrow(/bound to no slot/);
  });
});

describe('compareClashRunDocuments', () => {
  const wallBeam = (m1 = 'load-1', m2 = 'load-2') => clash(ref(m1, GUID_WALL, 2), ref(m2, GUID_BEAM, 3));
  const wallDuct = (m1 = 'load-1', m2 = 'load-2') => clash(ref(m1, GUID_WALL, 2), ref(m2, GUID_DUCT, 4));
  const matchedAll = (m1 = 'load-1', m2 = 'load-2') => [
    { model: m1, key: GUID_WALL, ref: 2 }, { model: m2, key: GUID_BEAM, ref: 3 }, { model: m2, key: GUID_DUCT, ref: 4 },
  ];

  it('partitions added / persistent / no longer detected across a re-load', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam()], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    const next = buildClashRunDocument({
      result: result([wallDuct('load-7', 'load-8')], [RULE], matchedAll('load-7', 'load-8')),
      slots: slots(SHA_A2, SHA_S1, 'load-7', 'load-8'),
    });
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.summary).toEqual({ added: 1, persistent: 0, noLongerDetected: 1, notComparable: 0 });
    expect(cmp.slots).toEqual({ arch: 'model-changed', struct: 'unchanged' });

    const again = buildClashRunDocument({ result: result([wallDuct('load-3', 'load-4')], [RULE], matchedAll('load-3', 'load-4')),
      slots: slots(SHA_A2, SHA_S1, 'load-3', 'load-4') });
    expect(compareClashRunDocuments(next, again).summary).toEqual({ added: 0, persistent: 1, noLongerDetected: 0, notComparable: 0 });
  });

  it('does not call a pair fixed when its element left the changed model', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam()], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    // The architect's new version re-minted the wall's GlobalId: the next run never saw GUID_WALL.
    const next = buildClashRunDocument({
      result: result([], [RULE], [{ model: 'load-1', key: 'NEW_WALL_GUID', ref: 2 }, { model: 'load-2', key: GUID_BEAM, ref: 3 }]),
      slots: slots(SHA_A2, SHA_S1),
    });
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.noLongerDetected).toEqual([]);
    expect(cmp.notComparable).toEqual([{ side: 'previous', finding: previous.findings[0], reasons: ['element-not-examined'] }]);

    const unrecorded = buildClashRunDocument({ result: result([]), slots: slots(SHA_A2, SHA_S1) });
    expect(compareClashRunDocuments(previous, unrecorded).notComparable[0].reasons).toEqual(['coverage-not-recorded']);
    // Same pinned models are not proof on their own: without per-side coverage it stays not comparable.
    const unchanged = buildClashRunDocument({ result: result([]), slots: slots(SHA_A1, SHA_S1) });
    expect(compareClashRunDocuments(previous, unchanged).notComparable[0].reasons).toEqual(['coverage-not-recorded']);
    const covered = buildClashRunDocument({ result: result([], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    expect(compareClashRunDocuments(previous, covered).summary.noLongerDetected).toBe(1);
  });

  it('does not call a pair fixed when its elements no longer sit on opposite rule sides', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam()], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    // Next version: the beam now matches side A too, and nothing matches side B.
    const next = buildClashRunDocument({
      result: { ...result([], [RULE]), ruleCoverage: [{ rule: RULE.id, matchedA: 2, matchedB: 0,
        matchedElements: [{ model: 'load-1', key: GUID_WALL, ref: 2 }, { model: 'load-2', key: GUID_BEAM, ref: 3 }],
        matchedKeysA: [GUID_BEAM, GUID_WALL], matchedKeysB: [] }] },
      slots: slots(SHA_A1, SHA_S1),
    });
    expect(next.manifest.coverage[0].examined).toEqual({ a: { arch: [GUID_WALL], struct: [GUID_BEAM] }, b: {} });
    expect(compareClashRunDocuments(previous, next).notComparable.map((e) => e.reasons)).toEqual([['pair-not-examined']]);
  });

  it('reports a changed rule and a missing slot as not comparable', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam()], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    const changedRule: ClashRule = { ...RULE, b: 'IfcBeam*' };
    const next = buildClashRunDocument({ result: result([wallBeam()], [changedRule], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.rules).toEqual({ 'mep-str': 'revision-changed' });
    expect(cmp.notComparable.map((e) => [e.side, e.reasons])).toEqual([
      ['previous', ['rule-revision-changed']], ['next', ['rule-revision-changed']],
    ]);

    const archOnly = buildClashRunDocument({ result: result([]), slots: [{ slot: 'arch', model: 'load-1', sha256: SHA_A1 }] });
    const cmp2 = compareClashRunDocuments(previous, archOnly);
    expect(cmp2.slots.struct).toBe('removed');
    expect(cmp2.notComparable[0].reasons).toEqual(['slot-not-in-other-run']);
  });

  it('does not call an excluded pair fixed, and fails closed without an exclusion record', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam()], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    const excluded = buildClashRunDocument({
      result: result([], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1),
      exclusions: makeExclusionSet([[qualifiedKey('load-1', GUID_WALL), qualifiedKey('load-2', GUID_BEAM)]]),
    });
    expect(excluded.manifest.exclusions).toEqual([JSON.stringify([['arch', GUID_WALL], ['struct', GUID_BEAM]])]);
    expect(compareClashRunDocuments(previous, excluded).notComparable.map((e) => e.reasons)).toEqual([['excluded-in-other-run']]);
    const unknown = buildWithoutDefaults({ result: result([], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    expect(unknown.manifest.exclusions).toBeNull();
    expect(compareClashRunDocuments(previous, unknown).notComparable.map((e) => e.reasons)).toEqual([['exclusions-not-recorded']]);
    // Nor is a pair "added" when the previous run may have excluded it.
    const unknownBefore = buildWithoutDefaults({ result: result([], [RULE], matchedAll()), slots: slots(SHA_A1, SHA_S1) });
    expect(compareClashRunDocuments(unknownBefore, previous).notComparable.map((e) => [e.side, e.reasons]))
      .toEqual([['next', ['exclusions-not-recorded']]]);
  });

  it('keeps ambiguous findings out of every detection bucket', () => {
    const dup = result([wallBeam(), clash(ref('load-1', GUID_WALL, 99), ref('load-2', GUID_BEAM, 3))]);
    const previous = buildClashRunDocument({ result: dup, slots: slots(SHA_A1, SHA_S1) });
    const next = buildClashRunDocument({ result: dup, slots: slots(SHA_A1, SHA_S1) });
    const cmp = compareClashRunDocuments(previous, next);
    expect(cmp.summary).toEqual({ added: 0, persistent: 0, noLongerDetected: 0, notComparable: 4 });
    expect(cmp.notComparable.every((e) => e.reasons.includes('ambiguous-identity'))).toBe(true);
  });
});

describe('carryForwardReviews', () => {
  const wallBeam = clash(ref('load-1', GUID_WALL, 2), ref('load-2', GUID_BEAM, 3));
  const wallDuct = clash(ref('load-1', GUID_WALL, 2), ref('load-2', GUID_DUCT, 4));
  const matched = [{ model: 'load-1', key: GUID_WALL, ref: 2 }, { model: 'load-2', key: GUID_BEAM, ref: 3 }, { model: 'load-2', key: GUID_DUCT, ref: 4 }];

  it('carries persistent decisions and reports the rest', () => {
    const base = buildClashRunDocument({ result: result([wallBeam, wallDuct], [RULE], matched), slots: slots(SHA_A1, SHA_S1) });
    const [beamKey, ductKey] = base.findings.map((f) => f.key!);
    const previous = buildClashRunDocument({
      result: result([wallBeam, wallDuct], [RULE], matched), slots: slots(SHA_A1, SHA_S1),
      reviews: { [beamKey]: { status: 'accepted', comment: 'by design' }, [ductKey]: { status: 'resolved' } },
    });
    const next = buildClashRunDocument({ result: result([wallBeam], [RULE], matched), slots: slots(SHA_A2, SHA_S1) });
    const carried = carryForwardReviews(previous, next);
    expect(carried.reviews).toEqual({ [beamKey]: { status: 'accepted', comment: 'by design' } });
    expect(carried.carried).toEqual([{ from: beamKey, to: beamKey, review: { status: 'accepted', comment: 'by design' }, via: 'key' }]);
    expect(carried.notCarried).toEqual([{ key: ductKey, review: { status: 'resolved' }, reason: 'no-longer-detected' }]);
    expect(carried.resolvedButStillDetected).toEqual([]);
  });

  it('does not carry across a changed rule or an ambiguous pair', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam], [RULE], matched), slots: slots(SHA_A1, SHA_S1) });
    const key = previous.findings[0].key!;
    const next = buildClashRunDocument({ result: result([wallBeam], [{ ...RULE, tolerance: 0.05 }], matched), slots: slots(SHA_A1, SHA_S1) });
    const carried = carryForwardReviews(previous, next, { [key]: { status: 'accepted' } });
    expect(carried.reviews).toEqual({});
    expect(carried.notCarried).toEqual([{ key, review: { status: 'accepted' }, reason: 'not-comparable', reasons: ['rule-revision-changed'] }]);

    const dupNext = buildClashRunDocument({
      result: result([wallBeam, clash(ref('load-1', GUID_WALL, 77), ref('load-2', GUID_BEAM, 3))], [RULE], matched),
      slots: slots(SHA_A1, SHA_S1),
    });
    const dupCarried = carryForwardReviews(previous, dupNext, { [key]: { status: 'accepted' } });
    expect(dupCarried.reviews).toEqual({});
    expect(dupCarried.notCarried[0]).toMatchObject({ reason: 'not-comparable', reasons: ['ambiguous-identity'] });
  });

  it('reads legacy keys when they name exactly one comparable finding', () => {
    const previous = buildClashRunDocument({ result: result([wallBeam], [RULE], matched), slots: slots(SHA_A1, SHA_S1) });
    const next = buildClashRunDocument({ result: result([wallBeam], [RULE], matched), slots: slots(SHA_A1, SHA_S1) });
    const legacy = clashReviewKey(wallBeam);
    const carried = carryForwardReviews(previous, next, { [legacy]: { status: 'resolved' }, 'mep-str X Y': { status: 'open' } });
    expect(carried.carried).toEqual([{ from: legacy, to: next.findings[0].key, review: { status: 'resolved' }, via: 'legacy-key' }]);
    expect(carried.resolvedButStillDetected).toEqual([next.findings[0].key]);
    expect(carried.notCarried).toEqual([{ key: 'mep-str X Y', review: { status: 'open' }, reason: 'legacy-key-unmatched' }]);

    // The same GlobalIds clashing in another slot are a different pair: a legacy key must not jump there.
    const moved = buildClashRunDocument({
      result: result([clash(ref('load-1', GUID_WALL, 2), ref('load-3', GUID_BEAM, 30))], [RULE],
        [...matched, { model: 'load-3', key: GUID_BEAM, ref: 30 }]),
      slots: [...slots(SHA_A1, SHA_S1), { slot: 'struct-ref', model: 'load-3', sha256: SHA_A2 }],
    });
    const jumped = carryForwardReviews(previous, moved, { [legacy]: { status: 'accepted' } });
    expect(jumped.reviews).toEqual({});
    expect(jumped.notCarried.map((n) => n.reason)).toEqual(['not-comparable']);

    const both = carryForwardReviews(previous, next, { [legacy]: { status: 'resolved' }, [next.findings[0].key!]: { status: 'accepted' } });
    expect(both.reviews).toEqual({ [next.findings[0].key!]: { status: 'accepted' } });
    expect(both.notCarried).toEqual([{ key: legacy, review: { status: 'resolved' }, reason: 'superseded' }]);
  });
});
