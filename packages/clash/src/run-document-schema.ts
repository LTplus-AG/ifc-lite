/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON Schema (draft 2020-12) of `ClashRunDocument`, and a dependency-free
 * validator for a document read back from storage. The schema is for hosts
 * that validate in another language or at an API boundary; the validator
 * checks the same constraints in-process and names every failing path.
 */

import { CLASH_RUN_DOCUMENT_SCHEMA_ID, CLASH_RUN_DOCUMENT_VERSION, type ClashRunDocument } from './run-document.js';

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;
const nullableString = { type: ['string', 'null'] } as const;
const stringList = { type: 'array', items: { type: 'string' } } as const;
const slotKeyLists = { type: 'object', additionalProperties: stringList } as const;
const endpoint = {
  type: 'object',
  required: ['slot', 'key', 'globalId', 'type'],
  properties: {
    slot: { type: 'string' }, key: { type: 'string' }, globalId: nullableString, type: { type: 'string' },
    name: { type: 'string' }, ambiguous: { const: true },
  },
} as const;

/** The run document's JSON Schema. */
export const CLASH_RUN_DOCUMENT_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: CLASH_RUN_DOCUMENT_SCHEMA_ID,
  title: 'ifc-lite clash run',
  type: 'object',
  required: ['schema', 'version', 'runId', 'createdAt', 'labels', 'manifest', 'findings'],
  properties: {
    schema: { const: CLASH_RUN_DOCUMENT_SCHEMA_ID },
    version: { const: CLASH_RUN_DOCUMENT_VERSION },
    runId: nullableString,
    createdAt: { type: 'string', format: 'date-time' },
    labels: stringList,
    manifest: {
      type: 'object',
      required: ['slots', 'rules', 'engine', 'settings', 'coverage', 'ambiguousKeys', 'truncated'],
      properties: {
        slots: { type: 'array', items: { type: 'object', required: ['slot', 'sha256'],
          properties: { slot: { type: 'string' }, sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
            label: { type: 'string' }, name: { type: 'string' } } } },
        rules: { type: 'object', required: ['revision', 'items'], properties: {
          revision: { type: 'string' },
          items: { type: 'array', items: { type: 'object',
            required: ['id', 'name', 'revision', 'a', 'b', 'mode', 'tolerance', 'clearance', 'reportTouch', 'explicitMembers'],
            properties: {
              id: { type: 'string' }, name: { type: 'string' }, revision: { type: 'string' }, a: { type: 'string' },
              b: nullableString, mode: { enum: ['hard', 'clearance'] }, tolerance: { type: 'number' },
              clearance: { type: ['number', 'null'] }, reportTouch: { type: 'boolean' },
              explicitMembers: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'boolean' }, b: { type: 'boolean' } } },
            } } },
        } },
        engine: { type: 'object', required: ['name', 'version', 'build', 'backend'], properties: {
          name: { type: 'string' }, version: nullableString, build: nullableString, backend: nullableString } },
        settings: { type: 'object', required: ['tolerance', 'excludeVoidsAndHosts'], properties: {
          tolerance: { type: 'number' }, excludeVoidsAndHosts: { type: 'boolean' } } },
        coverage: { type: 'array', items: { type: 'object', required: ['rule', 'matchedA', 'matchedB', 'candidatesExamined', 'examined'],
          properties: { rule: { type: 'string' }, matchedA: { type: 'integer' }, matchedB: { type: ['integer', 'null'] },
            candidatesExamined: { type: ['integer', 'null'] }, examined: { anyOf: [slotKeyLists, { type: 'null' }] } } } },
        ambiguousKeys: slotKeyLists,
        truncated: { anyOf: [{ type: 'null' }, { type: 'object', required: ['reason', 'droppedPairs'],
          properties: { reason: { type: 'string' }, droppedPairs: { type: 'integer' } } }] },
      },
    },
    findings: { type: 'array', items: { type: 'object',
      required: ['id', 'key', 'legacyKey', 'rule', 'ruleRevision', 'status', 'severity', 'distance', 'distanceKind', 'volume', 'point', 'bbox', 'a', 'b'],
      properties: {
        id: { type: 'string' }, key: nullableString, legacyKey: { type: 'string' }, rule: { type: 'string' },
        ruleRevision: { type: 'string' }, status: { enum: ['hard', 'clearance', 'touch'] },
        severity: { enum: ['critical', 'major', 'minor', 'info'] }, distance: { type: 'number' },
        distanceKind: { enum: ['mesh', 'estimate', null] }, volume: { type: ['number', 'null'] }, point: vec3,
        bbox: { type: 'object', required: ['min', 'max'], properties: { min: vec3, max: vec3 } },
        a: endpoint, b: endpoint,
        review: { type: 'object', required: ['status'], properties: {
          status: { enum: ['open', 'resolved', 'accepted'] }, comment: { type: 'string' }, updatedAt: { type: 'number' } } },
      } } },
  },
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
const obj = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p, e) => {
  if (!isRecord(v)) return fail(e, p, 'an object');
  for (const [key, check] of Object.entries(required)) {
    if (!Object.hasOwn(v, key)) e.push(`${p}.${key}: missing`);
    else check(v[key], `${p}.${key}`, e);
  }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(v, key)) check(v[key], `${p}.${key}`, e);
};
const keyLists: Check = (v, p, e) => {
  if (!isRecord(v)) return fail(e, p, 'an object of string lists');
  for (const [slot, keys] of Object.entries(v)) list(str)(keys, `${p}.${slot}`, e);
};
const sha: Check = (v, p, e) => {
  if (v !== null && (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))) fail(e, p, 'a lowercase hex sha256 or null');
};
const date: Check = (v, p, e) => {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fail(e, p, 'an ISO date-time string');
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
    coverage: list(obj({ rule: str, matchedA: int, matchedB: nint, candidatesExamined: nint, examined: nullable(keyLists) })),
    ambiguousKeys: keyLists,
    truncated: nullable(obj({ reason: str, droppedPairs: int })),
  }),
  findings: list(obj({
    id: str, key: nstr, legacyKey: str, rule: str, ruleRevision: str, status: oneOf('hard', 'clearance', 'touch'),
    severity: oneOf('critical', 'major', 'minor', 'info'), distance: num, distanceKind: oneOf('mesh', 'estimate', null),
    volume: nnum, point: vec, bbox: obj({ min: vec, max: vec }), a: endpointCheck, b: endpointCheck,
  }, { review: obj({ status: oneOf('open', 'resolved', 'accepted') }, { comment: str, updatedAt: num }) })),
});

/** Check a value read back from storage against the run-document schema. */
export function validateClashRunDocument(value: unknown): ClashRunValidation {
  const errors: string[] = [];
  documentCheck(value, '$', errors);
  if (errors.length === 0 && isRecord(value) && isRecord(value.manifest)) {
    const slots = (value.manifest.slots as Array<{ slot: string }>).map((s) => s.slot);
    if (new Set(slots).size !== slots.length) errors.push('$.manifest.slots: duplicate slot id');
    const known = new Set(slots);
    (value.findings as Array<{ a: { slot: string }; b: { slot: string } }>).forEach((finding, i) => {
      for (const side of ['a', 'b'] as const) {
        if (!known.has(finding[side].slot)) errors.push(`$.findings[${i}].${side}.slot: not in manifest.slots`);
      }
    });
  }
  return errors.length === 0 ? { ok: true, document: value as ClashRunDocument } : { ok: false, errors };
}
