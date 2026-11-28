/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON Schema (draft 2020-12) of `ClashRunDocument`, and a dependency-free
 * validator for a document read back from storage. The schema is for hosts
 * that validate in another language or at an API boundary; the validator
 * checks the same shape in-process, names every failing path, and also checks
 * what a schema cannot: that each finding is consistent with itself and with
 * its manifest. A host stores documents a browser submitted, so it must not
 * trust a key that does not follow from the finding's own elements and rule.
 *
 * Version 1 is CLOSED: unknown properties are refused everywhere a shape is
 * fixed (`additionalProperties: false`), so a misspelt optional field fails
 * instead of being dropped. A future field means a new `version`.
 */

import { clashElementIdentity, clashPairId } from './object-identity.js';
import { parseClashReviewKey, slotPairKey } from './review.js';
import {
  clashRuleSetRevision,
  CLASH_RUN_DOCUMENT_SCHEMA_ID,
  CLASH_RUN_DOCUMENT_VERSION,
  type ClashRunDocument,
} from './run-document.js';

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;
const nullableString = { type: ['string', 'null'] } as const;
const stringList = { type: 'array', items: { type: 'string' } } as const;
const slotKeyLists = { type: 'object', additionalProperties: stringList } as const;
/** A fixed-shape object: listed properties only. */
const closed = <const R extends readonly string[], const P extends Record<string, unknown>>(required: R, properties: P) =>
  ({ type: 'object', required, properties, additionalProperties: false }) as const;
const endpoint = closed(['slot', 'key', 'globalId', 'type'], {
  slot: { type: 'string' }, key: { type: 'string' }, globalId: nullableString, type: { type: 'string' },
  name: { type: 'string' }, ambiguous: { const: true },
});

/** The run document's JSON Schema. */
export const CLASH_RUN_DOCUMENT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: CLASH_RUN_DOCUMENT_SCHEMA_ID,
  title: 'ifc-lite clash run',
  description: 'Version 1 is closed: unknown properties are refused; a new field means a new version. '
    + 'Consistency between findings and the manifest (keys, rule revisions, unique ids) is checked by validateClashRunDocument.',
  ...closed(['schema', 'version', 'runId', 'createdAt', 'labels', 'manifest', 'findings'], {
    schema: { const: CLASH_RUN_DOCUMENT_SCHEMA_ID },
    version: { const: CLASH_RUN_DOCUMENT_VERSION },
    runId: nullableString,
    createdAt: { type: 'string', format: 'date-time' },
    labels: stringList,
    manifest: closed(['slots', 'rules', 'engine', 'settings', 'coverage', 'ambiguousKeys', 'exclusions', 'exclusionRules', 'truncated'], {
      slots: { type: 'array', items: closed(['slot', 'sha256'], {
        slot: { type: 'string' }, sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
        label: { type: 'string' }, name: { type: 'string' } }) },
      rules: closed(['revision', 'items'], {
        revision: { type: 'string' },
        items: { type: 'array', items: closed(
          ['id', 'name', 'revision', 'a', 'b', 'mode', 'tolerance', 'clearance', 'reportTouch', 'explicitMembers'], {
            id: { type: 'string' }, name: { type: 'string' }, revision: { type: 'string' }, a: { type: 'string' },
            b: nullableString, mode: { enum: ['hard', 'clearance'] }, tolerance: { type: 'number' },
            clearance: { type: ['number', 'null'] }, reportTouch: { type: 'boolean' },
            explicitMembers: closed(['a', 'b'], { a: { type: 'boolean' }, b: { type: 'boolean' } }),
          }) },
      }),
      engine: closed(['name', 'version', 'build', 'backend'], {
        name: { type: 'string' }, version: nullableString, build: nullableString, backend: nullableString }),
      settings: closed(['tolerance', 'excludeVoidsAndHosts'], { tolerance: { type: 'number' }, excludeVoidsAndHosts: { type: 'boolean' } }),
      coverage: { type: 'array', items: closed(['rule', 'matchedA', 'matchedB', 'candidatesExamined', 'examined'], {
        rule: { type: 'string' }, matchedA: { type: 'integer' }, matchedB: { type: ['integer', 'null'] },
        candidatesExamined: { type: ['integer', 'null'] },
        examined: { anyOf: [{ type: 'null' }, closed(['a', 'b'], { a: slotKeyLists, b: { anyOf: [slotKeyLists, { type: 'null' }] } })] },
      }) },
      ambiguousKeys: slotKeyLists,
      exclusions: { anyOf: [stringList, { type: 'null' }] },
      exclusionRules: { type: 'array', items: { oneOf: [
        closed(['kind', 'type'], { kind: { const: 'type' }, type: { type: 'string' } }),
        closed(['kind', 'a', 'b'], { kind: { const: 'typePair' }, a: { type: 'string' }, b: { type: 'string' } }),
        closed(['kind', 'a', 'b'], { kind: { const: 'elementKeyPair' }, a: { type: 'string' }, b: { type: 'string' } }),
      ] } },
      truncated: { anyOf: [{ type: 'null' }, closed(['reason', 'droppedPairs'], { reason: { type: 'string' }, droppedPairs: { type: 'integer' } })] },
    }),
    findings: { type: 'array', items: closed(
      ['id', 'key', 'legacyKey', 'rule', 'ruleRevision', 'status', 'severity', 'distance', 'distanceKind', 'volume', 'point', 'bbox', 'a', 'b'], {
        id: { type: 'string' }, key: nullableString, legacyKey: { type: 'string' }, rule: { type: 'string' },
        ruleRevision: { type: 'string' }, status: { enum: ['hard', 'clearance', 'touch'] },
        severity: { enum: ['critical', 'major', 'minor', 'info'] }, distance: { type: 'number' },
        distanceKind: { enum: ['mesh', 'estimate', null] }, volume: { type: ['number', 'null'] }, point: vec3,
        bbox: closed(['min', 'max'], { min: vec3, max: vec3 }),
        a: endpoint, b: endpoint,
        review: closed(['status'], { status: { enum: ['open', 'resolved', 'accepted'] }, comment: { type: 'string' }, updatedAt: { type: 'number' } }),
      }) },
  }),
} as const;

export type ClashRunValidation = { ok: true; document: ClashRunDocument } | { ok: false; errors: string[] };

type Check = (value: unknown, path: string, errors: string[]) => void;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (errors: string[], path: string, expected: string) => { errors.push(`${path}: expected ${expected}`); };

const str: Check = (v, p, e) => { if (typeof v !== 'string') fail(e, p, 'a string'); };
const nstr: Check = (v, p, e) => { if (v !== null && typeof v !== 'string') fail(e, p, 'a string or null'); };
const num: Check = (v, p, e) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(e, p, 'a finite number'); };
const nnum: Check = (v, p, e) => { if (v !== null) num(v, p, e); };
const int: Check = (v, p, e) => { if (!Number.isInteger(v)) fail(e, p, 'an integer'); };
const nint: Check = (v, p, e) => { if (v !== null) int(v, p, e); };
const bool: Check = (v, p, e) => { if (typeof v !== 'boolean') fail(e, p, 'a boolean'); };
const oneOf = (...allowed: readonly unknown[]): Check => (v, p, e) => {
  if (!allowed.includes(v)) fail(e, p, `one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}`);
};
const list = (item: Check): Check => (v, p, e) => {
  if (!Array.isArray(v)) return fail(e, p, 'an array');
  v.forEach((x, i) => item(x, `${p}[${i}]`, e));
};
const nullable = (check: Check): Check => (v, p, e) => { if (v !== null) check(v, p, e); };
const vec: Check = (v, p, e) => {
  if (!Array.isArray(v) || v.length !== 3) return fail(e, p, 'three numbers');
  v.forEach((x, i) => num(x, `${p}[${i}]`, e));
};
/** A closed object: required and optional properties, and nothing else. */
const obj = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p, e) => {
  if (!isRecord(v)) return fail(e, p, 'an object');
  for (const key of Object.keys(v)) {
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) e.push(`${p}.${JSON.stringify(key)}: unknown property`);
  }
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(v, key)) e.push(`${p}.${key}: missing`);
    else check(v[key], `${p}.${key}`, e);
  }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(v, key)) check(v[key], `${p}.${key}`, e);
};
const keyLists: Check = (v, p, e) => {
  if (!isRecord(v)) return fail(e, p, 'an object of string lists');
  for (const [slot, keys] of Object.entries(v)) list(str)(keys, `${p}.${JSON.stringify(slot)}`, e);
};
const sha: Check = (v, p, e) => {
  if (v !== null && (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))) fail(e, p, 'a lowercase hex sha256 or null');
};
/** RFC 3339 date-time, as the schema's `format: 'date-time'` requires: date, time and offset. */
const DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/i;
/** A real calendar date: `Date.parse` rolls 2026-02-31 over to March instead of refusing it. */
function realCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const date: Check = (v, p, e) => {
  if (typeof v !== 'string' || !DATE_TIME.test(v) || !realCalendarDate(v) || Number.isNaN(Date.parse(v))) {
    fail(e, p, 'an RFC 3339 date-time string');
  }
};

const endpointCheck = obj({ slot: str, key: str, globalId: nstr, type: str }, { name: str, ambiguous: oneOf(true) });
const documentCheck = obj({
  schema: oneOf(CLASH_RUN_DOCUMENT_SCHEMA_ID),
  version: oneOf(CLASH_RUN_DOCUMENT_VERSION),
  runId: nstr,
  createdAt: date,
  labels: list(str),
  manifest: obj({
    slots: list(obj({ slot: str, sha256: sha }, { label: str, name: str })),
    rules: obj({ revision: str, items: list(obj({
      id: str, name: str, revision: str, a: str, b: nstr, mode: oneOf('hard', 'clearance'), tolerance: num,
      clearance: nnum, reportTouch: bool, explicitMembers: obj({ a: bool, b: bool }),
    })) }),
    engine: obj({ name: str, version: nstr, build: nstr, backend: nstr }),
    settings: obj({ tolerance: num, excludeVoidsAndHosts: bool }),
    coverage: list(obj({ rule: str, matchedA: int, matchedB: nint, candidatesExamined: nint, examined: nullable(obj({ a: keyLists, b: nullable(keyLists) })) })),
    ambiguousKeys: keyLists,
    exclusions: nullable(list(str)),
    exclusionRules: list((v, p, e) => {
      const kind = isRecord(v) ? v.kind : undefined;
      if (kind === 'type') obj({ kind: str, type: str })(v, p, e);
      else if (kind === 'typePair' || kind === 'elementKeyPair') obj({ kind: str, a: str, b: str })(v, p, e);
      else fail(e, p, 'an exclusion rule of kind "type", "typePair" or "elementKeyPair"');
    }),
    truncated: nullable(obj({ reason: str, droppedPairs: int })),
  }),
  findings: list(obj({
    id: str, key: nstr, legacyKey: str, rule: str, ruleRevision: str, status: oneOf('hard', 'clearance', 'touch'),
    severity: oneOf('critical', 'major', 'minor', 'info'), distance: num, distanceKind: oneOf('mesh', 'estimate', null),
    volume: nnum, point: vec, bbox: obj({ min: vec, max: vec }), a: endpointCheck, b: endpointCheck,
  }, { review: obj({ status: oneOf('open', 'resolved', 'accepted') }, { comment: str, updatedAt: num }) })),
});

/** An element's legacy identity: its key, or for a repeated key `@[key, ref]` with an integer ref. */
function identityNames(identity: string, end: ClashRunDocument['findings'][number]['a']): boolean {
  if (identity === clashElementIdentity({ key: end.key, ref: 0 })) return true;
  if (end.ambiguous !== true || !identity.startsWith('@')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(identity.slice(1));
  } catch {
    return false; // not an encoded identity: the caller reports the legacy key as not following
  }
  return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === end.key && Number.isInteger(parsed[1]);
}

/** Whether a finding's legacy key is this rule over exactly its two elements (either order). */
function legacyKeyNames(finding: ClashRunDocument['findings'][number]): boolean {
  const parsed = parseClashReviewKey(finding.legacyKey);
  if (parsed?.format !== 'legacy' || parsed.rule !== finding.rule) return false;
  return (identityNames(parsed.a, finding.a) && identityNames(parsed.b, finding.b))
    || (identityNames(parsed.a, finding.b) && identityNames(parsed.b, finding.a));
}

/**
 * What the schema cannot express: every finding must follow from its own
 * elements and rule, and agree with the manifest. Without these a stored
 * document could carry a key naming one pair on a finding about another, and
 * a carried decision would land on the wrong elements.
 */
function consistencyErrors(doc: ClashRunDocument): string[] {
  const errors: string[] = [];
  const { manifest } = doc;
  const slots = new Set<string>();
  for (const { slot } of manifest.slots) {
    if (slots.has(slot)) errors.push(`$.manifest.slots: duplicate slot id ${JSON.stringify(slot)}`);
    slots.add(slot);
  }
  const revisions = new Map<string, string>();
  for (const rule of manifest.rules.items) {
    if (revisions.has(rule.id)) errors.push(`$.manifest.rules.items: duplicate rule id ${JSON.stringify(rule.id)}`);
    revisions.set(rule.id, rule.revision);
  }
  if (manifest.rules.revision !== clashRuleSetRevision(manifest.rules.items)) {
    errors.push('$.manifest.rules.revision: does not match the listed rules and revisions');
  }
  manifest.coverage.forEach((entry, i) => {
    if (!revisions.has(entry.rule)) errors.push(`$.manifest.coverage[${i}].rule: not in manifest.rules`);
  });
  const ambiguous = new Map(Object.entries(manifest.ambiguousKeys).map(([slot, keys]) => [slot, new Set(keys)]));
  const ids = new Set<string>();
  doc.findings.forEach((finding, i) => {
    const at = `$.findings[${i}]`;
    if (ids.has(finding.id)) errors.push(`${at}.id: duplicate finding id ${JSON.stringify(finding.id)}`);
    ids.add(finding.id);
    for (const side of ['a', 'b'] as const) {
      const end = finding[side];
      if (!slots.has(end.slot)) errors.push(`${at}.${side}.slot: not in manifest.slots`);
      if ((end.ambiguous === true) !== (ambiguous.get(end.slot)?.has(end.key) === true)) {
        errors.push(`${at}.${side}.ambiguous: disagrees with manifest.ambiguousKeys`);
      }
    }
    const revision = revisions.get(finding.rule);
    if (revision === undefined) errors.push(`${at}.rule: not in manifest.rules`);
    else if (revision !== finding.ruleRevision) errors.push(`${at}.ruleRevision: does not match the manifest rule's revision`);
    const keyless = finding.a.ambiguous === true || finding.b.ambiguous === true;
    if (keyless) {
      if (finding.key !== null) errors.push(`${at}.key: must be null when an element's key is ambiguous`);
      // The legacy key of an ambiguous endpoint embeds a per-load ref the document does not store,
      // so check its structure instead: this rule, and identities naming exactly these two elements.
      if (!legacyKeyNames(finding)) errors.push(`${at}.legacyKey: does not follow from the finding's elements and rule`);
      return;
    }
    const expected = slotPairKey(finding.rule, finding.ruleRevision, [finding.a.slot, finding.a.key], [finding.b.slot, finding.b.key]);
    if (finding.key !== expected) errors.push(`${at}.key: does not follow from the finding's elements and rule`);
    const legacy = clashPairId(finding.rule, clashElementIdentity({ key: finding.a.key, ref: 0 }), clashElementIdentity({ key: finding.b.key, ref: 0 }));
    if (finding.legacyKey !== legacy) errors.push(`${at}.legacyKey: does not follow from the finding's elements and rule`);
  });
  return errors;
}

/** Check a value read back from storage: its shape, then its internal consistency. */
export function validateClashRunDocument(value: unknown): ClashRunValidation {
  const errors: string[] = [];
  documentCheck(value, '$', errors);
  // Consistency is checked even when the shape is wrong, so one pass names every failing path. A part
  // malformed enough to stop it (e.g. `findings` not an array) is already named by the shape errors.
  try {
    errors.push(...consistencyErrors(value as ClashRunDocument));
  } catch (err) {
    if (errors.length === 0) throw err;
    errors.push(`$: consistency checks stopped at a malformed part (${err instanceof Error ? err.message : String(err)})`);
  }
  return errors.length === 0 ? { ok: true, document: value as ClashRunDocument } : { ok: false, errors };
}
