/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseSidecar, parseStudioDocument, SIDECAR_FORMAT, type StudioDocument } from '@ifc-lite/ids-authoring';
import type { IdsStudioDraft } from './draft-codec.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every(key => value[key] === undefined || typeof value[key] === 'string');
}

/** Check the constraints the editor renders, including restrictions on imported IDS files. */
function validConstraint(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 32 || !optionalStrings(value, ['base'])) return false;
  if (value.and !== undefined && (!Array.isArray(value.and) || !value.and.every(child => validConstraint(child, depth + 1)))) return false;
  switch (value.type) {
    case 'simpleValue': return typeof value.value === 'string';
    case 'pattern': return typeof value.pattern === 'string';
    case 'enumeration': return Array.isArray(value.values) && value.values.every(item => typeof item === 'string');
    case 'bounds':
      return ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive', 'length', 'minLength', 'maxLength',
        'totalDigits', 'fractionDigits'].every(key => value[key] === undefined || Number.isFinite(value[key]))
        && (value.temporalBounds === undefined || (isRecord(value.temporalBounds)
          && Object.values(value.temporalBounds).every(item => typeof item === 'string')))
        && (value.unparseableFacets === undefined || (Array.isArray(value.unparseableFacets)
          && value.unparseableFacets.every(item => isRecord(item) && typeof item.facet === 'string' && typeof item.rawValue === 'string')));
    default: return false;
  }
}

function validFacet(facet: unknown, nested = false): boolean {
  if (!isRecord(facet) || !optionalStrings(facet, ['instructions', 'uri'])) return false;
  const optional = (key: string) => facet[key] === undefined || validConstraint(facet[key]);
  switch (facet.type) {
    case 'entity': return validConstraint(facet.name) && optional('predefinedType');
    case 'attribute': return validConstraint(facet.name) && optional('value');
    case 'property': return validConstraint(facet.propertySet) && validConstraint(facet.baseName) && optional('dataType') && optional('value');
    case 'classification': return optional('system') && optional('value');
    case 'material': return optional('value');
    case 'partOf': return !nested && typeof facet.relation === 'string' && optionalStrings(facet, ['rawRelation'])
      && (facet.anyRelation === undefined || typeof facet.anyRelation === 'boolean')
      && (facet.entity === undefined || (isRecord(facet.entity) && facet.entity.type === 'entity' && validFacet(facet.entity, true)))
      && (facet.facets === undefined || (Array.isArray(facet.facets) && facet.facets.every(child => validFacet(child, true))));
    default: return false;
  }
}

/** Validate document, node identities and metadata before mounting any editor over stored bytes. */
export function readIdsDraftDocument(draft: IdsStudioDraft): StudioDocument {
  const doc = parseStudioDocument(JSON.parse(draft.document));
  parseSidecar(JSON.stringify({
    format: SIDECAR_FORMAT, idsFingerprint: '', schemaVersion: doc.schemaVersion,
    docId: doc.docId, nodes: doc.nodes, meta: doc.meta,
  }));
  const { ids } = doc;
  if (typeof ids.info.title !== 'string' || !Object.values(ids.info).every(value => typeof value === 'string')
    || !optionalStrings({ ...ids }, ['schemaLocation'])) throw new Error('Invalid IDS draft header');
  for (const spec of ids.specifications) {
    if (typeof spec.name !== 'string' || !Array.isArray(spec.ifcVersions)
      || !spec.ifcVersions.every(version => typeof version === 'string')
      || !optionalStrings({ ...spec }, ['description', 'instructions', 'ifcVersionRaw', 'identifier'])
      || (spec.minOccurs !== undefined && !Number.isFinite(spec.minOccurs))
      || (spec.maxOccurs !== undefined && spec.maxOccurs !== 'unbounded' && !Number.isFinite(spec.maxOccurs))
      || !spec.applicability.facets.every(facet => validFacet(facet))
      || !spec.requirements.every(requirement => validFacet(requirement.facet)
        && ['required', 'optional', 'prohibited'].includes(requirement.optionality)
        && optionalStrings({ ...requirement }, ['cardinalityRaw', 'description', 'instructions']))) {
      throw new Error('Invalid IDS draft specification');
    }
  }
  return doc;
}
