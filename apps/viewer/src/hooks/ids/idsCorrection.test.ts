/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PropertyValueType } from '@ifc-lite/data';
import type {
  IDSRequirementResult,
  IDSRequirement,
  RequirementOptionality,
} from '@ifc-lite/ids';

import {
  checkCorrectionEligibility,
  inferValueType,
  parseCorrectionValue,
  applyPropertyCorrection,
  CorrectionValueError,
  type PropertyMutationSink,
} from './idsCorrection.js';

function propertyRequirement(
  overrides: Partial<{ optionality: RequirementOptionality }> = {},
): IDSRequirement {
  return {
    id: 'req-1',
    optionality: overrides.optionality ?? 'required',
    facet: {
      type: 'property',
      propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
      baseName: { type: 'simpleValue', value: 'FireRating' },
    },
  };
}

function failedResult(requirement: IDSRequirement, facetType: IDSRequirementResult['facetType'] = 'property'): IDSRequirementResult {
  return {
    requirement,
    status: 'fail',
    facetType,
    checkedDescription: 'Pset_WallCommon.FireRating is present',
  };
}

describe('checkCorrectionEligibility (#3929)', () => {
  it('accepts a failed, required, exact-name property requirement', () => {
    const result = checkCorrectionEligibility(failedResult(propertyRequirement()));
    assert.deepStrictEqual(result, {
      eligible: true,
      psetName: 'Pset_WallCommon',
      propName: 'FireRating',
    });
  });

  it('accepts an optional requirement too', () => {
    const result = checkCorrectionEligibility(
      failedResult(propertyRequirement({ optionality: 'optional' })),
    );
    assert.ok(result.eligible);
  });

  it('rejects a passed requirement — nothing to correct', () => {
    const req = propertyRequirement();
    const result = checkCorrectionEligibility({
      requirement: req,
      status: 'pass',
      facetType: 'property',
      checkedDescription: '',
    });
    assert.strictEqual(result.eligible, false);
  });

  it('rejects a non-property facet type (e.g. attribute, classification, material, entity, partOf)', () => {
    for (const facetType of ['attribute', 'classification', 'material', 'entity', 'partOf'] as const) {
      const req: IDSRequirement = {
        id: 'r',
        optionality: 'required',
        facet: { type: 'attribute', name: { type: 'simpleValue', value: 'Name' } },
      };
      const result = checkCorrectionEligibility(failedResult(req, facetType));
      assert.strictEqual(result.eligible, false, `expected ${facetType} to be rejected`);
    }
  });

  it('rejects a prohibited requirement — correction sets a value, prohibited wants none', () => {
    const result = checkCorrectionEligibility(
      failedResult(propertyRequirement({ optionality: 'prohibited' })),
    );
    assert.strictEqual(result.eligible, false);
  });

  it('rejects a pattern-constrained property set name (ambiguous target)', () => {
    const req: IDSRequirement = {
      id: 'r',
      optionality: 'required',
      facet: {
        type: 'property',
        propertySet: { type: 'pattern', pattern: 'Pset_.*Common' },
        baseName: { type: 'simpleValue', value: 'FireRating' },
      },
    };
    const result = checkCorrectionEligibility(failedResult(req));
    assert.strictEqual(result.eligible, false);
  });

  it('rejects an enumeration-constrained property name (ambiguous target)', () => {
    const req: IDSRequirement = {
      id: 'r',
      optionality: 'required',
      facet: {
        type: 'property',
        propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
        baseName: { type: 'enumeration', values: ['FireRating', 'Combustible'] },
      },
    };
    const result = checkCorrectionEligibility(failedResult(req));
    assert.strictEqual(result.eligible, false);
  });

  it('a substring-adjacent pset name is never conflated with the exact one (no fuzzy fallback)', () => {
    // Regression guard for the exact-match discipline: METRE/MILLIMETRE-shaped
    // bugs come from treating "close enough" as a match. Here the facet names
    // an exact set; eligibility must report exactly that string, not something
    // derived by trimming/normalizing it.
    const req: IDSRequirement = {
      id: 'r',
      optionality: 'required',
      facet: {
        type: 'property',
        propertySet: { type: 'simpleValue', value: 'Pset_WallCommon' },
        baseName: { type: 'simpleValue', value: 'FireRatingExtended' },
      },
    };
    const result = checkCorrectionEligibility(failedResult(req));
    assert.ok(result.eligible);
    if (result.eligible) {
      assert.strictEqual(result.propName, 'FireRatingExtended');
    }
  });
});

describe('inferValueType', () => {
  it('prefers the existing property dataType over the IDS facet dataType', () => {
    assert.strictEqual(inferValueType('IFCBOOLEAN', 'IFCLABEL'), PropertyValueType.Boolean);
  });
  it('falls back to the IDS facet dataType when there is no existing value', () => {
    assert.strictEqual(inferValueType(undefined, 'IFCINTEGER'), PropertyValueType.Integer);
  });
  it('defaults to String when neither is known', () => {
    assert.strictEqual(inferValueType(undefined, undefined), PropertyValueType.String);
  });
  it('maps REAL/MEASURE/RATIO dataTypes to Real', () => {
    assert.strictEqual(inferValueType('IFCLENGTHMEASURE', undefined), PropertyValueType.Real);
    assert.strictEqual(inferValueType('IFCPOSITIVERATIOMEASURE', undefined), PropertyValueType.Real);
  });
});

describe('parseCorrectionValue', () => {
  it('parses a real number', () => {
    assert.strictEqual(parseCorrectionValue('90', PropertyValueType.Real), 90);
  });
  it('rejects a non-numeric real', () => {
    assert.throws(() => parseCorrectionValue('abc', PropertyValueType.Real), CorrectionValueError);
  });
  it('rejects a fractional integer', () => {
    assert.throws(() => parseCorrectionValue('1.5', PropertyValueType.Integer), CorrectionValueError);
  });
  it('parses booleans from common tokens', () => {
    assert.strictEqual(parseCorrectionValue('true', PropertyValueType.Boolean), true);
    assert.strictEqual(parseCorrectionValue('0', PropertyValueType.Boolean), false);
  });
  it('rejects an unrecognized boolean token', () => {
    assert.throws(() => parseCorrectionValue('maybe', PropertyValueType.Boolean), CorrectionValueError);
  });
  it('passes strings through unchanged', () => {
    assert.strictEqual(parseCorrectionValue('F90', PropertyValueType.String), 'F90');
  });
});

describe('applyPropertyCorrection — write-then-verify (#3929)', () => {
  const target = { psetName: 'Pset_WallCommon', propName: 'FireRating' };

  it('reports success only when the read-back matches the written value', () => {
    const store = new Map<string, string | number | boolean | null>();
    const sink: PropertyMutationSink = {
      setProperty: (entityId, pset, prop, value) => {
        store.set(`${entityId}:${pset}:${prop}`, value as string | number | boolean | null);
      },
      getPropertyValue: (entityId, pset, prop) => store.get(`${entityId}:${pset}:${prop}`) ?? null,
    };

    const result = applyPropertyCorrection(sink, 42, target, 'F90', PropertyValueType.String);
    assert.deepStrictEqual(result, { expressId: 42, applied: true });
  });

  it('does NOT report success when the write silently no-ops (the dominant defect shape here)', () => {
    // Simulates the exact failure mode called out in the task: a mutation
    // sink whose write is swallowed (wrong key, dropped entity id, whatever)
    // but does not throw. Without a read-back check this would report
    // `applied: true` even though nothing changed.
    const sink: PropertyMutationSink = {
      setProperty: () => {
        /* no-op — the mutation is silently dropped */
      },
      getPropertyValue: () => 'NONE', // unchanged original value
    };

    const result = applyPropertyCorrection(sink, 42, target, 'F90', PropertyValueType.String);
    assert.strictEqual(result.applied, false);
    assert.ok(result.error, 'expected a visible error, not a silent false');
  });

  it('does NOT report success when the write lands on the wrong property (mutation: wrong key)', () => {
    const store = new Map<string, string | number | boolean | null>();
    const sink: PropertyMutationSink = {
      // Mutates a DIFFERENT property than the one requested.
      setProperty: (entityId) => {
        store.set(`${entityId}:Pset_WallCommon:OtherProp`, 'F90');
      },
      getPropertyValue: (entityId, pset, prop) => store.get(`${entityId}:${pset}:${prop}`) ?? null,
    };

    const result = applyPropertyCorrection(sink, 42, target, 'F90', PropertyValueType.String);
    assert.strictEqual(result.applied, false);
  });

  it('surfaces a thrown error from the mutation sink rather than swallowing it', () => {
    const sink: PropertyMutationSink = {
      setProperty: () => {
        throw new Error('entity has no property table');
      },
      getPropertyValue: () => null,
    };

    const result = applyPropertyCorrection(sink, 42, target, 'F90', PropertyValueType.String);
    assert.strictEqual(result.applied, false);
    assert.match(result.error ?? '', /entity has no property table/);
  });

  it('correcting one entity does not disturb a sibling entity (control: isolation)', () => {
    const store = new Map<string, string | number | boolean | null>([
      ['1:Pset_WallCommon:FireRating', 'NONE'],
      ['2:Pset_WallCommon:FireRating', 'NONE'],
    ]);
    const sink: PropertyMutationSink = {
      setProperty: (entityId, pset, prop, value) => {
        store.set(`${entityId}:${pset}:${prop}`, value as string | number | boolean | null);
      },
      getPropertyValue: (entityId, pset, prop) => store.get(`${entityId}:${pset}:${prop}`) ?? null,
    };

    const result = applyPropertyCorrection(sink, 1, target, 'F90', PropertyValueType.String);
    assert.ok(result.applied);
    assert.strictEqual(store.get('2:Pset_WallCommon:FireRating'), 'NONE');
  });
});
