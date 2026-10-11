/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only proposals for reviewed check authoring (P07, #6915), written
 * against the committed SketchUp-authored `building-architecture` sample and
 * its derived `building-architecture.ids`.
 */

import { readFileSync } from 'node:fs';
import type { IfcDataStore } from '@ifc-lite/parser';
import { parseIfc } from './authoring-sample-fixture';

export const SAMPLE_IDS_XML = readFileSync(new URL('../../public/samples/building-architecture.ids', import.meta.url), 'utf8');

export function parseSampleIfc(): Promise<IfcDataStore> {
  return parseIfc(readFileSync(new URL('../../public/samples/building-architecture.ifc', import.meta.url)));
}

/** The committed sample IDS, written as an `ids.specifications` proposal. */
export const SAMPLE_IDS_PROPOSAL = {
  version: 1, kind: 'ids.specifications', title: 'Building Architecture IDS',
  specifications: [
    { name: 'Spaces are named', ifcVersions: ['IFC4'], applicability: [{ type: 'entity', name: 'IFCSPACE' }],
      requirements: [{ type: 'attribute', name: 'Name' }] },
    { name: 'Walls are external', applicability: [{ type: 'entity', name: 'IfcWall' }],
      requirements: [{ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'IsExternal', dataType: 'IFCBOOLEAN', value: true }] },
    { name: 'Building element proxies declare an ObjectType', applicability: [{ type: 'entity', name: 'IFCBUILDINGELEMENTPROXY' }],
      requirements: [{ type: 'attribute', name: 'ObjectType', cardinality: 'required' }] },
  ],
} as const;

const chips = (rules: unknown[]) => ({ groups: [{ combinator: 'AND', rules }], authoredAs: 'chips' });

/** Native information rules in the shapes the provider guidance teaches. */
export const SAMPLE_RULES_PROPOSAL = {
  version: 1, kind: 'rules.proposal', title: 'Wall information',
  ruleSet: { version: 1, name: 'Wall information', rules: [
    { id: 'wall-fire-rating', name: 'Walls state a fire rating', severity: 'error',
      applicability: chips([{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }]),
      requirement: { kind: 'element', block: chips([{ kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'isSet', value: '' }]) } },
    { id: 'wall-names-unique', name: 'Wall names are unique', severity: 'warning',
      applicability: chips([{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }]),
      requirement: { kind: 'unique', subject: { kind: 'name' } } },
  ] },
  unsupported: [{ text: 'Walls between flats achieve 53 dB airborne sound insulation', reason: 'acoustic performance needs a test certificate', relatesTo: 'Walls state a fire rating' }],
} as const;

export const json = (value: unknown): string => JSON.stringify(value);
