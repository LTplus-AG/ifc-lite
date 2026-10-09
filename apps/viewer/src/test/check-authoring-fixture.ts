/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only drafts and proposals for reviewed check authoring (P07, #6915), written
 * against the committed SketchUp-authored `building-architecture` sample and
 * its derived `building-architecture.ids`.
 */

import { readFileSync } from 'node:fs';
import type { IDSDocument, IFCVersion } from '@ifc-lite/ids';
import { apply, createStudioDocument, deriveId, type FacetDraft, type StudioOp } from '@ifc-lite/ids-authoring';
import { idsDraftOf, type IdsDraft } from '@/lib/check-authoring/ids-draft';
import type { UnsupportedRequirement } from '@/lib/check-authoring/proposal-json';
import type { IfcDataStore } from '@ifc-lite/parser';
import { parseIfc } from './authoring-sample-fixture';

export const SAMPLE_IDS_XML = readFileSync(new URL('../../public/samples/building-architecture.ids', import.meta.url), 'utf8');

export function parseSampleIfc(): Promise<IfcDataStore> {
  return parseIfc(readFileSync(new URL('../../public/samples/building-architecture.ifc', import.meta.url)));
}

export interface SampleSpec {
  name: string;
  ifcVersions?: IFCVersion[];
  cardinality?: 'required' | 'optional' | 'prohibited';
  applicability: FacetDraft[];
  requirements: FacetDraft[];
}

const eq = (value: string | boolean) => ({ kind: 'equals' as const, value });

/** The committed sample IDS, as the specifications an IDS-agent run would write. */
export const SAMPLE_IDS_SPECS: readonly SampleSpec[] = [
  { name: 'Spaces are named', applicability: [{ type: 'entity', name: eq('IFCSPACE') }], requirements: [{ type: 'attribute', name: eq('Name') }] },
  { name: 'Walls are external', applicability: [{ type: 'entity', name: eq('IfcWall') }],
    requirements: [{ type: 'property', propertySet: eq('Pset_WallCommon'), baseName: eq('IsExternal'), dataType: eq('IFCBOOLEAN'), value: eq(true) }] },
  { name: 'Building element proxies declare an ObjectType', applicability: [{ type: 'entity', name: eq('IFCBUILDINGELEMENTPROXY') }],
    requirements: [{ type: 'attribute', name: eq('ObjectType') }] },
];

/** An IDS document written through the authoring ops (the only way the agent writes one). */
export function idsDocumentOf(title: string, specs: readonly SampleSpec[]): IDSDocument {
  let n = 0;
  const id = () => deriveId('check-authoring-fixture', String(n++));
  const ops: StudioOp[] = specs.flatMap((spec): StudioOp[] => {
    const specId = id();
    return [
      { kind: 'spec.add', opId: id(), payload: { specId, name: spec.name, ifcVersions: spec.ifcVersions ?? ['IFC4'], ...(spec.cardinality ? { cardinality: spec.cardinality } : {}) } },
      ...spec.applicability.map((facet): StudioOp => ({ kind: 'facet.add', opId: id(), payload: { specId, section: 'applicability', facetId: id(), facet } })),
      ...spec.requirements.map((facet): StudioOp => ({ kind: 'facet.add', opId: id(), payload: { specId, section: 'requirements', facetId: id(), facet } })),
    ];
  });
  return apply(createStudioDocument({ title, newId: id }), ops).doc.ids;
}

/** The sample as a draft for the native gates. */
export function sampleIdsDraft(title = 'Building Architecture IDS', unsupported: UnsupportedRequirement[] = [], specs = SAMPLE_IDS_SPECS): IdsDraft {
  return idsDraftOf(idsDocumentOf(title, specs), unsupported);
}

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
