/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Small builders for gate tests: one spec, then facet ops against it. */

import type { IFCVersion } from '@ifc-lite/ids';
import { createStudioDocument } from '../src/document/from-ids.js';
import type { StudioDocument } from '../src/document/types.js';
import type { FacetDraft, StudioOp, ValueInput } from '../src/ops/types.js';
import { apply } from '../src/reducer/apply.js';
import { counterIds } from './corpus.js';

export const ids = counterIds(0x6a7e);

export const eq = (value: string | number | boolean): ValueInput => ({ kind: 'equals', value });

export interface SpecFixture {
  doc: StudioDocument;
  specId: string;
}

/** A doc with one spec for `versions`, optionally with an applicability entity. */
export function specDoc(versions: IFCVersion[], entity?: string): SpecFixture {
  const specId = ids();
  const ops: StudioOp[] = [{ kind: 'spec.add', opId: ids(), payload: { specId, name: 'S', ifcVersions: versions } }];
  if (entity) {
    ops.push({
      kind: 'facet.add',
      opId: ids(),
      payload: { specId, section: 'applicability', facetId: ids(), facet: { type: 'entity', name: eq(entity) } },
    });
  }
  return { doc: apply(createStudioDocument({ newId: ids }), ops).doc, specId };
}

export function addFacet(specId: string, facet: FacetDraft, section: 'applicability' | 'requirements' = 'requirements'): StudioOp {
  return { kind: 'facet.add', opId: ids(), payload: { specId, section, facetId: ids(), facet } };
}

export function prop(pset: string, name: string, extra: Partial<Extract<FacetDraft, { type: 'property' }>> = {}): FacetDraft {
  return { type: 'property', propertySet: eq(pset), baseName: eq(name), ...extra };
}
