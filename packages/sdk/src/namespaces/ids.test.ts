/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IDSNamespace } from './ids.js';
import type {
  IDSDocument,
  IDSSimpleValue,
  IDSModelInfo,
  IFCDataAccessor,
} from '@ifc-lite/ids';

const ids = new IDSNamespace();

// `IDSNamespace` dynamically imports `@ifc-lite/ids` on first use (see
// `loadIDS` in ids.ts) so that SDK consumers who never touch `bim.ids`
// don't pay for it. That's the right tradeoff for real callers, who load
// the module once and then reuse it — but it means whichever test in this
// file happens to be the first to call `validate`/`parse`/etc. pays the
// one-time cold-import cost inside its own timer. Under CI's parallel test
// load that cost alone can approach the default 5s test timeout. Warm the
// import here, during module collection (unbounded by any per-test or
// per-hook timeout), so the locale test below only times the logic it
// exists to check.
await import('@ifc-lite/ids');

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/** Minimal IFCDataAccessor over a single entity missing its Name attribute. */
function makeAccessor(): IFCDataAccessor {
  return {
    getEntityType: (id) => (id === 1 ? 'IfcWall' : undefined),
    getEntityName: () => undefined,
    getGlobalId: () => undefined,
    getDescription: () => undefined,
    getObjectType: () => undefined,
    getEntitiesByType: (typeName) => (typeName.toUpperCase() === 'IFCWALL' ? [1] : []),
    getAllEntityIds: () => [1],
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
    getClassifications: () => [],
    getMaterials: () => [],
    getParent: () => undefined,
    getAttribute: () => undefined,
  };
}

function makeDoc(): IDSDocument {
  return {
    info: { title: 'Locale test' },
    specifications: [
      {
        id: 'spec-0',
        name: 'Walls must have a name',
        ifcVersions: ['IFC4'],
        applicability: { facets: [{ type: 'entity', name: sv('IFCWALL') }] },
        requirements: [
          {
            id: 'req-0',
            facet: { type: 'attribute', name: sv('Name') },
            optionality: 'required',
          },
        ],
      },
    ],
  };
}

const modelInfo: IDSModelInfo = {
  modelId: 'test-model',
  schemaVersion: 'IFC4',
  entityCount: 1,
};

describe('IDSNamespace.validate — locale', () => {
  it('produces a German failure message when locale is "de"', async () => {
    const reportEn = (await ids.validate(makeDoc(), {
      accessor: makeAccessor(),
      modelInfo,
      locale: 'en',
    })) as {
      specificationResults: Array<{
        entityResults: Array<{ requirementResults: Array<{ failureReason?: string }> }>;
      }>;
    };
    const reportDe = (await ids.validate(makeDoc(), {
      accessor: makeAccessor(),
      modelInfo,
      locale: 'de',
    })) as typeof reportEn;

    const enReason = reportEn.specificationResults[0].entityResults[0].requirementResults[0]
      .failureReason;
    const deReason = reportDe.specificationResults[0].entityResults[0].requirementResults[0]
      .failureReason;

    expect(enReason).toBeTruthy();
    expect(deReason).toBeTruthy();
    expect(deReason).not.toBe(enReason);
  });
});

describe('IDSNamespace.summarize', () => {
  it('derives spec pass/fail from entity results when no status is present', () => {
    const summary = ids.summarize({
      specificationResults: [
        { entityResults: [{ passed: true }, { passed: false }] },
        { entityResults: [{ passed: true }] },
      ],
    });

    expect(summary.totalSpecifications).toBe(2);
    expect(summary.failedSpecifications).toBe(1);
    expect(summary.passedSpecifications).toBe(1);
    expect(summary.totalEntities).toBe(3);
    expect(summary.failedEntities).toBe(1);
  });

  it('prefers the validator spec status — cardinality-only failures count as failed', () => {
    // A required spec matching zero entities has no entity results at
    // all, yet the validator marks it failed. Deriving purely from
    // entity results used to report it as passed, making this summary
    // disagree with the validator's own report.summary (and the CLI's
    // text-mode verdict).
    const summary = ids.summarize({
      specificationResults: [
        { entityResults: [], status: 'fail' },
        { entityResults: [{ passed: true }], status: 'pass' },
        { entityResults: [], status: 'not_applicable' },
      ],
    });

    expect(summary.totalSpecifications).toBe(3);
    expect(summary.failedSpecifications).toBe(1);
    // Legacy shape invariant: passed + failed = total, so a
    // not-applicable spec counts as non-failed here.
    expect(summary.passedSpecifications).toBe(2);
  });

  it('prohibited spec violated by passing entities counts as failed when status says so', () => {
    const summary = ids.summarize({
      specificationResults: [
        // maxOccurs=0 spec: the matched entity "passes" its (empty)
        // requirements but the spec itself fails on cardinality.
        { entityResults: [{ passed: true }], status: 'fail' },
      ],
    });

    expect(summary.failedSpecifications).toBe(1);
    expect(summary.passedSpecifications).toBe(0);
    expect(summary.failedEntities).toBe(0);
  });
});
