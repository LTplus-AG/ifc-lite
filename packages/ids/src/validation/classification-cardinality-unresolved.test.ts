/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import type { IDSDocument, IDSRequirement } from '../types.js';
import { validateIDS } from './validator.js';

describe('unresolved classification cardinality through validateIDS (#3954 / #3996)', () => {
  let full: IfcDataStore;
  beforeAll(async () => {
    const bytes = readFileSync(new URL('../__corpus__/buildingsmart-ids/classification/pass-non_rooted_resources_that_have_external_classification_references_should_also_pass.ifc', import.meta.url));
    full = await new IfcParser().parseColumnar(
      Uint8Array.from(bytes).buffer, { disableWorkerScan: true },
    );
  });

  for (const optionality of ['required', 'optional', 'prohibited'] as const) {
    for (const sourceEmpty of [false, true]) {
      it(`${optionality}: ${sourceEmpty ? 'unknown presence never passes' : 'real classified material obeys cardinality'}`, async () => {
        const store = sourceEmpty
          ? { ...full, source: EMPTY_SOURCE_BYTES, onDemandClassificationMap: undefined }
          : full;
        const requirement: IDSRequirement = { id: 'classification', facet: { type: 'classification' }, optionality };
        const document: IDSDocument = {
          info: { title: 'Classification cardinality regression' },
          specifications: [{
            id: 'material', name: 'Material classification', ifcVersions: ['IFC4'],
            applicability: { facets: [{ type: 'entity', name: { type: 'simpleValue', value: 'IFCMATERIAL' } }] },
            requirements: [requirement],
          }],
        };
        const report = await validateIDS(document, createDataAccessor(store), {
          modelId: 'fixture', schemaVersion: 'IFC4', entityCount: store.entityCount,
        });
        const specification = report.specificationResults[0];
        const expectedPass = !sourceEmpty && optionality !== 'prohibited';
        expect(specification.applicableCount).toBe(1);
        expect(specification.passedCount).toBe(expectedPass ? 1 : 0);
        expect(specification.failedCount).toBe(expectedPass ? 0 : 1);
        const entity = specification.entityResults[0];
        expect(entity.expressId).toBe(16);
        const result = entity.requirementResults[0];
        expect(result.status).toBe(expectedPass ? 'pass' : 'fail');
        expect(result.requirement.optionality).toBe(optionality);
        if (sourceEmpty) {
          expect(result.failure?.type).toBe('CLASSIFICATION_UNRESOLVED');
          expect(result.failureReason).toBeTruthy();
          expect(result.failureReason).not.toContain('Prohibited: found');
        }
      });
    }
  }
});
