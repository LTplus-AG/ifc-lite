/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3951 review: `CLASSIFICATION_UNRESOLVED` (added for #3948) never got a
 * message case in either message formatter, so both fell through to their
 * `default` branch and showed the raw internal enum name to the user —
 * indistinguishable in the UI from a real, definite violation:
 *
 *   "Validation failed: CLASSIFICATION_UNRESOLVED"
 *
 * This pins the user-facing text for both formatters, and pins that a
 * genuinely unclassified entity's message is unaffected.
 */

import { describe, it, expect } from 'vitest';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { checkClassificationFacet } from '../facets/classification-facet.js';
import { createTranslationService } from '../translation/index.js';
import { formatFailureReason } from './validator.js';
import type { IDSClassificationFacet, IDSSimpleValue, IDSRequirementResult } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

function serverStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  builder.addEdge(300, 100, RelationshipType.AssociatesClassification, 200);
  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandClassificationMap: undefined,
  } as unknown as IfcDataStore;
}

function unclassifiedServerStore(): IfcDataStore {
  const builder = new RelationshipGraphBuilder();
  builder.addEdge(300, 100, RelationshipType.AssociatesClassification, 200);
  return {
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    relationships: builder.build(),
    onDemandClassificationMap: undefined,
  } as unknown as IfcDataStore;
}

const valueFacet: IDSClassificationFacet = { type: 'classification', value: sv('Ss_25_10') };
const presenceFacet: IDSClassificationFacet = { type: 'classification' };

describe('CLASSIFICATION_UNRESOLVED user-facing message (#3951)', () => {
  it('formatFailureReason (validator.ts, no-translator path) does not leak the raw enum', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkClassificationFacet(valueFacet, 100, accessor);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');

    const message = formatFailureReason(result);
    expect(message).not.toBe('Validation failed: CLASSIFICATION_UNRESOLVED');
    expect(message.toLowerCase()).not.toContain('classification_unresolved');
  });

  it('describeFailure (translation/service.ts, en) does not leak the raw enum', () => {
    const accessor = createDataAccessor(serverStore());
    const result = checkClassificationFacet(valueFacet, 100, accessor);
    expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');

    const translator = createTranslationService('en');
    const message = translator.describeFailure({ failure: result.failure } as unknown as IDSRequirementResult);
    expect(message).not.toBe('Validation failed: CLASSIFICATION_UNRESOLVED');
    expect(message.toLowerCase()).not.toContain('classification_unresolved');
  });

  it('control: a genuinely unclassified entity still reports the unchanged CLASSIFICATION_MISSING message', () => {
    const accessor = createDataAccessor(unclassifiedServerStore());
    const result = checkClassificationFacet(presenceFacet, 999, accessor);
    expect(result.failure?.type).toBe('CLASSIFICATION_MISSING');
    expect(formatFailureReason(result)).toBe('No classification found');

    const translator = createTranslationService('en');
    const message = translator.describeFailure({ failure: result.failure } as unknown as IDSRequirementResult);
    expect(message).toBe('No classification assigned');
  });
});
