/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `validate`'s two element-scanning rules — `named-elements` and
 * `quantity-completeness` — read `store.entityIndex.byType`, which is keyed by
 * the raw STEP type name. A caller writing `IfcWallElementedCase` therefore
 * lands in a different bucket from `IfcWall`, and a rule that lists only the
 * base spelling walks past it.
 *
 * Which types the two rules cover at all is a policy choice (neither claims to
 * cover every IfcProduct). Whether a listed type's own concrete subtypes are
 * covered is not: `IfcWallStandardCase` is an `IfcWall`, so a rule that says it
 * looks at walls must see it. The expansion is `expandTypes` from
 * `@ifc-lite/parser`, the same one all three `byType()` backends use, so these
 * rules and `byType('IfcWall')` cannot answer "is this a wall" differently.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, IFC_SUBTYPES, expandTypes, type IfcDataStore } from '@ifc-lite/parser';
import { loadInlineModel } from '../headless-test-helpers.js';
import {
  computeValidationIssues,
  NAMED_ELEMENT_BASE_TYPES,
  QUANTIFIABLE_BASE_TYPES,
  namedElementTypes,
  quantifiableTypes,
} from './validate.js';

function buildIfc(dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

const SPATIAL = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,$,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,$,$,$,$);",
];

/** One entity of `type`, unnamed and carrying no quantity set. */
function bareElement(id: number, type: string, guid: string): string {
  return `#${id}=${type}('${guid}',$,$,$,$,$,$,$,$);`;
}

function issueFor(store: IfcDataStore, rule: string) {
  return computeValidationIssues(store).find((i) => i.rule === rule);
}

describe('validate covers the concrete subtypes of the types it lists', () => {
  // The four spellings `quantity-completeness` used to miss, and the ten that
  // `named-elements` used to miss, each expressed as the subtype of a base type
  // both rules already list.
  const CASES: { base: string; sub: string }[] = [];
  for (const base of ['IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCDOOR', 'IFCWINDOW', 'IFCMEMBER', 'IFCPLATE']) {
    for (const sub of IFC_SUBTYPES[base] ?? []) CASES.push({ base, sub });
  }

  it('has a case for every subtype the schema declares under a listed base type', () => {
    // Guards the loop below against silently testing nothing.
    expect(CASES.length).toBe(10);
  });

  for (const { base, sub } of CASES) {
    it(`counts an unnamed ${sub} under named-elements, as it does ${base}`, async () => {
      const store = await parse(buildIfc([...SPATIAL, bareElement(10, sub, '0Sub_GUID_000000001')]));
      const issue = issueFor(store, 'named-elements');
      expect(issue?.message).toBe('1 building elements have no Name');
    });

    it(`counts a ${sub} with no quantity set under quantity-completeness, as it does ${base}`, async () => {
      const store = await parse(buildIfc([...SPATIAL, bareElement(10, sub, '0Sub_GUID_000000001')]));
      const issue = issueFor(store, 'quantity-completeness');
      expect(issue?.message).toContain('1/1 building elements');
    });
  }
});

describe('the scanned type lists stay derived, not hand-copied', () => {
  it.each([
    ['named-elements', NAMED_ELEMENT_BASE_TYPES, namedElementTypes],
    ['quantity-completeness', QUANTIFIABLE_BASE_TYPES, quantifiableTypes],
  ])('%s expands exactly the subtypes the schema declares', (_rule, bases, scanned) => {
    // Both directions: every declared subtype of a listed base is scanned, and
    // nothing is scanned that the base list plus the schema does not imply.
    // Per schema version, because the answer is not the same on each.
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3']) {
      expect([...scanned(version)].sort(), version).toEqual(
        [...new Set(expandTypes([...bases], version))].sort(),
      );
    }
  });

  it.each([
    ['named-elements', NAMED_ELEMENT_BASE_TYPES],
    ['quantity-completeness', QUANTIFIABLE_BASE_TYPES],
  ])('%s lists only base types, never a subtype spelling', (_rule, bases) => {
    // A subtype written into the base list would survive the expansion check
    // above while re-introducing the hand-maintenance this replaces.
    const subtypes = new Set(Object.values(IFC_SUBTYPES).flat());
    expect([...bases].filter((t) => subtypes.has(t))).toEqual([]);
  });
});

/**
 * The scanned lists are computed PER STORE, from the model's own
 * `schemaVersion`.
 *
 * They were computed once at module load, with no model in hand, which is only
 * sound while the expansion is a property of the schema tables alone. It is
 * not: a descendant set differs by version, so a list frozen at the IFC4
 * answer counted records on an IFC4X3 file that `byType` did not — the exact
 * disagreement the doc at the top of `validate.ts` says cannot happen.
 *
 * `validate-subtypes`'s other cases all parse IFC4 fixtures, so they compare
 * two IFC4 answers and cannot see it. These are IFC4X3 and IFC2X3 on purpose,
 * and they compare the validator against a real `byType` over the SAME store
 * rather than pinning the shape of the function that feeds both.
 */
describe('the scanned lists and byType agree on a file that is not IFC4', () => {
  const SLABS = [
    "#10=IFCSLAB('0Slab_GUID_00000001',$,$,$,$,$,$,$,$);",
    "#11=IFCSLABSTANDARDCASE('0SlabSC_GUID_000001',$,$,$,$,$,$,$,$);",
  ];

  function buildIfcWithSchema(schema: string, dataLines: string[]): string {
    return [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION((''),'2;1');",
      "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
      `FILE_SCHEMA(('${schema}'));`,
      'ENDSEC;',
      'DATA;',
      ...dataLines,
      'ENDSEC;',
      'END-ISO-10303-21;',
      '',
    ].join('\n');
  }

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])(
    'named-elements counts both slabs on a %s file, and byType finds both',
    async (schema) => {
      const source = buildIfcWithSchema(schema, [...SPATIAL, ...SLABS]);
      const store = await parse(source);
      expect(store.schemaVersion).toBe(schema);

      const counted = issueFor(store, 'named-elements');
      expect(counted?.message).toBe('2 building elements have no Name');

      const bim = await loadInlineModel(source, `validate-${schema}`);
      expect(bim.query().byType('IfcSlab').toArray()).toHaveLength(2);
    },
  );

  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])(
    'the validator scans exactly the buckets byType reads, on the same %s store',
    async (schema) => {
      // The behavioural form of the invariant: same store, same question. A
      // list computed against a different schema than the store's would show
      // up here as a bucket one side reads and the other does not.
      const source = buildIfcWithSchema(schema, [...SPATIAL, ...SLABS]);
      const store = await parse(source);
      const scanned = new Set(namedElementTypes(store.schemaVersion));

      const bim = await loadInlineModel(source, `validate-buckets-${schema}`);
      const queried = bim.query().byType('IfcSlab').toArray().map((e) => e.type.toUpperCase());
      expect(queried.length).toBeGreaterThan(0);
      for (const type of queried) expect(scanned, `${schema}: ${type}`).toContain(type);
    },
  );
});
