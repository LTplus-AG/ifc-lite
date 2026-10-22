/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generate the fingerprint parity corpus consumed by
 * `rust/diff/tests/fingerprint_parity.rs`.
 *
 * The expected hashes are produced by RUNNING the shipped TypeScript engine,
 * never transcribed, so the fixture cannot drift from the implementation it
 * pins through a copy error. Regenerate with:
 *
 *     pnpm --filter @ifc-lite/diff build
 *     node scripts/diff-parity-vectors.mjs
 *
 * A regenerated file that differs is a real behaviour change in one engine or
 * the other, and wants explaining rather than committing blindly.
 *
 * Deliberately not run in CI. This is a generator, not a gate: it WRITES the
 * fixture that `cargo test -p ifc-lite-diff` then checks. Running it in CI
 * would let a drifting TypeScript engine silently rewrite its own
 * expectations, which is the one thing a committed fixture exists to prevent.
 * (The name is outside `check-*`/`verify-*`, so `check-test-wiring.mjs` does
 * not audit it and no `@unwired-by-design` declaration applies.)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { buildDataFingerprint, buildComponentFingerprints, stableHash } = await import(
  '../packages/diff/dist/fingerprint.js'
);

const PRIVATE_USE = String.fromCharCode(0xe000);
const ASTRAL = String.fromCodePoint(0x10000);
const EMOJI = String.fromCodePoint(0x1f600);

/** Cases chosen for the places a naive Rust port diverges. */
const CASES = [
  { id: 'minimal', input: { ifcType: 'IfcWall' } },
  {
    id: 'all-core-attributes',
    input: {
      ifcType: 'IfcWall',
      name: 'WT-200',
      description: 'Exterior wall',
      objectType: 'Basic Wall',
      predefinedType: 'SOLIDWALL',
      tag: '157200',
    },
  },
  {
    id: 'pset-member-order-is-irrelevant',
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'LoadBearing', value: true },
            { name: 'IsExternal', value: false },
            { name: 'FireRating', value: 'EI60' },
          ],
        },
      ],
    },
  },
  {
    id: 'pset-member-order-reversed',
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FireRating', value: 'EI60' },
            { name: 'IsExternal', value: false },
            { name: 'LoadBearing', value: true },
          ],
        },
      ],
    },
  },
  {
    id: 'same-named-psets-tiebreak-on-content',
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: false }] },
      ],
    },
  },
  {
    id: 'quantity-sets',
    input: {
      ifcType: 'IfcWall',
      quantitySets: [
        {
          name: 'Qto_WallBaseQuantities',
          quantities: [
            { name: 'NetVolume', value: 12.5 },
            { name: 'GrossArea', value: 40 },
          ],
        },
      ],
    },
  },
  {
    id: 'type-assignments-sorted-by-class-then-name-duplicates-kept',
    input: {
      ifcType: 'IfcWall',
      typeAssignments: [
        { globalId: 'IGNORED-0', name: 'b', type: 'IfcWallType' },
        { globalId: 'IGNORED-1', name: 'a', type: 'IfcWallType' },
        { globalId: 'IGNORED-2', name: 'a', type: 'IfcCovering' },
        { globalId: 'IGNORED-3', name: 'a', type: 'IfcWallType' },
      ],
    },
  },
  {
    id: 'type-assignment-globalid-is-not-hashed',
    input: {
      ifcType: 'IfcWall',
      typeAssignments: [{ globalId: 'TOTALLY-DIFFERENT', name: 'b', type: 'IfcWallType' }],
    },
  },
  {
    id: 'materials-blank-filtered-duplicates-kept',
    input: { ifcType: 'IfcWall', materials: ['steel', '', '   ', 'concrete', 'steel'] },
  },
  { id: 'materials-empty-equals-absent', input: { ifcType: 'IfcWall', materials: [] } },
  {
    id: 'classifications',
    input: { ifcType: 'IfcWall', classifications: ['Uniclass:EF_25_10', 'Uniclass:EF_25_30'] },
  },
  {
    id: 'non-finite-property-values',
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        {
          name: 'P',
          properties: [
            { name: 'nan', value: Number.NaN },
            { name: 'posinf', value: Number.POSITIVE_INFINITY },
            { name: 'neginf', value: Number.NEGATIVE_INFINITY },
          ],
        },
      ],
    },
  },
  {
    id: 'ecmascript-number-formatting',
    exactNumbers: true,
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        {
          name: 'P',
          properties: [
            { name: 'a-1e21', value: 1e21 },
            { name: 'b-1e-7', value: 1e-7 },
            { name: 'c-tenth', value: 0.1 },
            { name: 'd-negzero', value: -0 },
            { name: 'e-third', value: 1 / 3 },
            { name: 'f-denormal', value: 5e-324 },
            // The f64 nearest 123456789012345678901, written in exponent
            // form so the literal itself is exactly representable:
            // spelling the integer out trips `no-loss-of-precision`,
            // which is an ERROR-tier rule here, for a value whose
            // rounding is the very thing under test.
            { name: 'g-big-int', value: 1.2345678901234568e20 },
            { name: 'h-exact-int', value: 42 },
          ],
        },
      ],
    },
  },
  {
    id: 'utf16-vs-codepoint-sort-order',
    // The hazard case. In UTF-16 code-unit order the astral character
    // (D800 DC00) sorts BELOW U+E000; in Rust's native `str` order it sorts
    // above. If the port used Rust's ordering, these hashes would not match.
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        { name: PRIVATE_USE, properties: [{ name: 'x', value: 1 }] },
        { name: ASTRAL, properties: [{ name: 'y', value: 2 }] },
      ],
      materials: [PRIVATE_USE, ASTRAL],
    },
  },
  {
    id: 'json-escaping',
    input: {
      ifcType: 'IfcWall',
      name: ['quote "', 'backslash \\', 'slash /', 'tab \t', 'newline \n'].join(' '),
      description: [
        'controls',
        String.fromCharCode(0x00, 0x01, 0x1f),
        `del ${String.fromCharCode(0x7f)}`,
        `sep ${String.fromCharCode(0x2028, 0x2029)}`,
        `astral ${EMOJI}`,
      ].join(' '),
    },
  },
  {
    id: 'object-valued-property-key-order-irrelevant',
    input: {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'P', properties: [{ name: 'o', value: { b: 1, a: 2 } }] }],
    },
  },
  {
    id: 'object-valued-property-key-order-reversed',
    input: {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'P', properties: [{ name: 'o', value: { a: 2, b: 1 } }] }],
    },
  },
  {
    id: 'array-and-nested-values',
    input: {
      ifcType: 'IfcWall',
      propertySets: [
        {
          name: 'P',
          properties: [
            { name: 'arr', value: [1, 'two', true, null] },
            { name: 'nested', value: { outer: { inner: [1, 2] } } },
            { name: 'nullish', value: null },
          ],
        },
      ],
    },
  },
  {
    id: 'everything-at-once',
    input: {
      ifcType: 'IfcWallStandardCase',
      name: 'W-01',
      description: 'd',
      objectType: 'ot',
      predefinedType: 'SOLIDWALL',
      tag: 't',
      propertySets: [
        { name: 'Pset_B', properties: [{ name: 'q', value: 2 }] },
        { name: 'Pset_A', properties: [{ name: 'p', value: 1 }] },
      ],
      quantitySets: [{ name: 'Qto_A', quantities: [{ name: 'v', value: 3.5 }] }],
      typeAssignments: [{ name: 'WT', type: 'IfcWallType' }],
      materials: ['concrete'],
      classifications: ['Uniclass:EF_25_10'],
    },
  },
];

/** Strings whose hash pins the digest itself rather than the projection. */
const HASH_STRINGS = [
  '',
  'a',
  'hello',
  EMOJI,
  `${PRIVATE_USE}${PRIVATE_USE}`,
  '{"Type":"IfcWall"}',
  `${String.fromCharCode(0xe4, 0xe9, 0x2028)}`,
];

/**
 * Encode every number in a case as its exact IEEE-754 bit pattern.
 *
 * Needed because `serde_json`, which the Rust test uses to read this fixture,
 * does not round every decimal literal the way V8 does. Measured: V8 parses
 * `123456789012345680000` to bits `441ac53a7e04bcda` and round-trips it, while
 * `serde_json` yields `441ac53a7e04bcd9` -- one ULP lower, printing as
 * `123456789012345670000`. A formatting test read through that parser would
 * fail on a correct implementation, so for cases whose whole subject is number
 * formatting the fixture carries the bits and not a decimal.
 *
 * `approx` rides along for human review only; the Rust side ignores it.
 */
const f64Bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};

const encodeExactNumbers = (value) => {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { $f64: f64Bits(value), approx: value }
      : { $nonfinite: String(value) };
  }
  if (Array.isArray(value)) return value.map(encodeExactNumbers);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeExactNumbers(item)]),
    );
  }
  return value;
};

const vectors = {
  '//': 'GENERATED by scripts/diff-parity-vectors.mjs from packages/diff/dist - do not hand-edit.',
  engine: '@ifc-lite/diff',
  stableHash: HASH_STRINGS.map((value) => ({ value, hash: stableHash(value) })),
  fingerprints: CASES.map(({ id, input, exactNumbers }) => ({
    id,
    input: exactNumbers ? encodeExactNumbers(input) : input,
    dataHash: buildDataFingerprint(input),
    components: buildComponentFingerprints(input),
  })),
};

/**
 * JSON cannot hold a non-finite number: `JSON.stringify(NaN)` is `null`, the
 * same token an absent value produces. Writing the corpus without this would
 * hand the Rust side `null` where the hash was computed from `NaN`, and the
 * fixture would assert a case it does not actually carry. Encode them as a
 * tagged object instead; `fingerprint_parity.rs` decodes the tag.
 *
 * `-0` needs no such treatment: it serializes as `0`, and ECMAScript renders
 * `-0` as `"0"` anyway, so the hash is unaffected by the loss of sign.
 */
const encodeNonFinite = (_key, value) =>
  typeof value === 'number' && !Number.isFinite(value)
    ? { $nonfinite: String(value) }
    : value;

const out = fileURLToPath(new URL('../rust/diff/tests/fingerprint_vectors.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(vectors, encodeNonFinite, 2)}\n`);
console.log(
  `wrote ${out}: ${vectors.stableHash.length} hash vectors, ${vectors.fingerprints.length} fingerprint cases`,
);
