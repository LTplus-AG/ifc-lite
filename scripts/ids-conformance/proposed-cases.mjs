#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generates the corpus test cases proposed upstream in
 * `docs/architecture/ids-studio/upstream/` (IDS-126). Drafts only: they are
 * offered to buildingSMART, never added to the vendored corpus.
 *
 * Every `.ids` is written by `writeIdsXml` (the P-01 writer) from an
 * `IDSDocument` built here, so the files are what our writer emits; the
 * `.ifc` files are minimal hand-written STEP. The IDS 1.1 cases are written
 * with the IDS 1.1 preview. `packages/ids/src/__corpus__/proposed-cases.test.ts`
 * checks that ifc-lite gives each case the verdict in its name.
 *
 * Usage (build first: `pnpm turbo build --filter=@ifc-lite/ids...`):
 *   node scripts/ids-conformance/proposed-cases.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(REPO, 'docs/architecture/ids-studio/upstream/proposed-corpus-cases');

const simple = (value) => ({ type: 'simpleValue', value });
const wall = { type: 'entity', name: simple('IFCWALL') };

/** @param {string} name @param {object[]} applicability @param {object[]} requirements @param {string} [description] */
function doc(name, applicability, requirements, description) {
  return {
    info: { title: name, description, author: 'ids-studio@example.org' },
    specifications: [{
      id: 'spec-0', name, ifcVersions: ['IFC4'], minOccurs: 1, maxOccurs: 'unbounded',
      applicability: { facets: applicability },
      requirements: requirements.map((r, i) => ({ id: `req-${i}`, ...r })),
    }],
  };
}

/** A minimal IFC4 file: `lines` are DATA records after #1..#6 (project and units). */
function ifc(lines) {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('','2026-10-08T00:00:00',(),(),'ifc-lite proposed cases','ifc-lite proposed cases','');",
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Project',$,$,$,$,$,#6);",
    '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
    '#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);', '#5=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);',
    '#6=IFCUNITASSIGNMENT((#2,#3,#4,#5));',
    ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

/** A wall with one IfcPropertySingleValue `ProposedCases.<name>` holding `value` (STEP literal). */
const wallWithProperty = (name, value) => ifc([
  "#7=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',$,'Wall',$,$,$,$,$,$);",
  "#8=IFCPROPERTYSET('1ZwJH$85D3YQG5AK5ER$N2',$,'ProposedCases',$,(#10));",
  "#9=IFCRELDEFINESBYPROPERTIES('3B5Ay2BEz3QeKjTTnDPm0y',$,$,$,(#7),#8);",
  `#10=IFCPROPERTYSINGLEVALUE('${name}',$,${value},$);`,
]);

const property = (baseName, extra = {}) => ({ type: 'property', propertySet: simple('ProposedCases'), baseName: simple(baseName), ...extra });

/** @type {{ group: string, name: string, ids11?: boolean, doc: object, ifc: string }[]} */
export const CASES = [
  // 01: empty strings under optional and prohibited (#403).
  {
    group: 'property', name: 'pass-an_empty_string_is_absent_for_an_optional_property',
    doc: doc('Empty optional', [wall], [{ facet: property('Label', { dataType: simple('IFCLABEL') }), optionality: 'optional' }],
      'buildingSMART/IDS#403: an empty IFCLABEL is treated as absent, so an optional requirement passes.'),
    ifc: wallWithProperty('Label', "IFCLABEL('')"),
  },
  {
    group: 'property', name: 'pass-an_empty_string_is_absent_for_a_prohibited_property',
    doc: doc('Empty prohibited', [wall], [{ facet: property('Label'), optionality: 'prohibited' }],
      'buildingSMART/IDS#403: an empty IFCLABEL is treated as absent, so a prohibited requirement passes.'),
    ifc: wallWithProperty('Label', "IFCLABEL('')"),
  },
  // 02: a prohibited property with a value (#206, #420).
  {
    group: 'property', name: 'invalid-a_prohibited_property_cannot_constrain_a_value',
    doc: doc('Prohibited value', [wall], [{ facet: property('Note', { dataType: simple('IFCLABEL'), value: simple('n/a') }), optionality: 'prohibited' }],
      'buildingSMART/IDS#206, #420: a prohibited property with a value or dataType is not a valid IDS 1.0 configuration.'),
    ifc: wallWithProperty('Note', "IFCLABEL('ok')"),
  },
  // 03: tolerance at the far end of the upstream table (#418).
  {
    group: 'tolerance', name: 'pass-comparison_tolerance_for_floating_point_million_upper_bound',
    doc: doc('Tolerance 1e6', [wall], [{ facet: property('Length', { dataType: simple('IFCLENGTHMEASURE'), value: simple('1000000') }), optionality: 'required' }],
      'buildingSMART/IDS#418: 1000000 + 1000000e-6 + 1e-6 = 1000001.000001 is on the inclusive upper bound.'),
    ifc: wallWithProperty('Length', 'IFCLENGTHMEASURE(1000001.000001)'),
  },
  {
    group: 'tolerance', name: 'fail-comparison_tolerance_for_floating_point_million_upper_bound',
    doc: doc('Tolerance 1e6', [wall], [{ facet: property('Length', { dataType: simple('IFCLENGTHMEASURE'), value: simple('1000000') }), optionality: 'required' }],
      'buildingSMART/IDS#418: 1000001.000002 is outside the inclusive upper bound 1000001.000001.'),
    ifc: wallWithProperty('Length', 'IFCLENGTHMEASURE(1000001.000002)'),
  },
  // 04: IDS 1.1 candidate, facets nested in partOf (#379, draft PR #380).
  ...['01', '02'].map((storey) => ({
    group: 'ids11-partof', ids11: true,
    name: storey === '01' ? 'pass-a_nested_facet_selects_the_related_element' : 'fail-a_nested_facet_must_match_the_related_element',
    doc: doc('Spaces of storey 01', [{ type: 'entity', name: simple('IFCSPACE') }], [{
      facet: {
        type: 'partOf', relation: 'IfcRelAggregates', entity: { type: 'entity', name: simple('IFCBUILDINGSTOREY') },
        facets: [{ type: 'attribute', name: simple('Name'), value: simple('01') }],
      },
      optionality: 'required',
    }], 'IDS 1.1 candidate (buildingSMART/IDS#379, draft #380): the nested attribute facet applies to the related storey.'),
    ifc: ifc([
      `#7=IFCBUILDINGSTOREY('0Jv1vdWOv8Bx7JTU6t3$8M',$,'${storey}',$,$,$,$,$,.ELEMENT.,0.);`,
      "#8=IFCSPACE('1kTvXnbbzCWw8lcMd1dR4o',$,'Office',$,$,$,$,$,.ELEMENT.,.SPACE.,$);",
      "#9=IFCRELAGGREGATES('2Yr3m0ZQ9A8Ba5AUcwYoP$',$,$,$,#7,(#8));",
    ]),
  })),
];

async function main() {
  let ids;
  try {
    ids = await import(join(REPO, 'packages/ids/dist/index.js'));
  } catch (err) {
    throw new Error(`build @ifc-lite/ids first (${err instanceof Error ? err.message : String(err)})`);
  }
  rmSync(OUT, { recursive: true, force: true });
  for (const c of CASES) {
    const dir = join(OUT, c.group);
    mkdirSync(dir, { recursive: true });
    const options = c.ids11 ? { preview: { ids11: true } } : {};
    writeFileSync(join(dir, `${c.name}.ids`), ids.writeIdsXml(c.doc, {}, options));
    writeFileSync(join(dir, `${c.name}.ifc`), c.ifc);
  }
  console.log(`wrote ${CASES.length} proposed cases to ${OUT}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
