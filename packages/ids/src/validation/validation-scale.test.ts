/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale regressions for IDS validation.
 *
 * Real-world IDS documents (e.g. national code-list packs) carry
 * hundreds of specifications over the same entity population, with
 * enumeration constraints holding hundreds of values. Three pathologies
 * made such documents unusable on large models:
 *
 *   1. Accessor lookups (property sets in particular) were re-extracted
 *      once per specification per entity — O(specs × entities) source
 *      parses, minutes-to-hours of CPU.
 *   2. The entity-independent requirement description was re-formatted
 *      for every entity result.
 *   3. Enumeration constraints rendered ALL their values into every
 *      failure string (~20KB per result for an 800-value code list),
 *      ballooning reports into the gigabytes.
 */

import { validateIDS, createCachedAccessor } from './validator.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import { formatConstraint, matchConstraint, getConstraintMismatchReason } from '../constraints/index.js';
import type {
  IDSDocument,
  IDSSpecification,
  IDSModelInfo,
  IDSSimpleValue,
  IDSEnumerationConstraint,
  IFCDataAccessor,
  TranslationService,
} from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

const modelInfo: IDSModelInfo = {
  modelId: 'test-model',
  schemaVersion: 'IFC4',
  entityCount: 10,
};

function makeDoc(specs: IDSSpecification[]): IDSDocument {
  return { info: { title: 'Scale Test IDS' }, specifications: specs };
}

/** A spec whose applicability is a property facet only (no entity facet),
 * forcing the full-population scan path. */
function makePropertySpec(index: number, requiredProp: string): IDSSpecification {
  return {
    id: `spec-${index}`,
    name: `Spec ${index}`,
    ifcVersions: ['IFC4'],
    applicability: {
      facets: [
        {
          type: 'property',
          propertySet: sv('Pset_CodeList'),
          baseName: sv('CommonName'),
          value: sv('Pump'),
        },
      ],
    },
    requirements: [
      {
        id: `req-${index}`,
        facet: {
          type: 'property',
          propertySet: sv('Pset_CodeList'),
          baseName: sv(requiredProp),
        },
        optionality: 'required',
      },
    ],
    minOccurs: 0,
  };
}

function makeEntities(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    expressId: i + 1,
    type: 'IfcPump',
    name: `Pump_${i + 1}`,
    properties: [
      { psetName: 'Pset_CodeList', propName: 'CommonName', value: 'Pump' },
      { psetName: 'Pset_CodeList', propName: 'Code', value: `K-${i + 1}` },
    ],
  }));
}

describe('validateIDS — accessor lookups are cached across specifications', () => {
  it('extracts property sets at most once per entity for the whole run', async () => {
    const entityCount = 7;
    const specCount = 25;

    const base = createMockAccessor(makeEntities(entityCount));
    let psetCalls = 0;
    const counting: IFCDataAccessor = {
      ...base,
      getPropertySets(expressId: number) {
        psetCalls++;
        return base.getPropertySets(expressId);
      },
    };

    const specs = Array.from({ length: specCount }, (_, i) =>
      makePropertySpec(i, 'Code')
    );
    const report = await validateIDS(makeDoc(specs), counting, modelInfo);

    expect(report.summary.totalSpecifications).toBe(specCount);
    expect(report.summary.failedSpecifications).toBe(0);
    // Every spec checks every entity (applicability + requirement), so the
    // uncached behaviour was specs × entities × 2 calls. With the per-run
    // cache the underlying accessor is hit once per entity.
    expect(psetCalls).toBe(entityCount);
  });

  it('resolves getAllEntityIds once per run', async () => {
    const base = createMockAccessor(makeEntities(3));
    let allIdsCalls = 0;
    const counting: IFCDataAccessor = {
      ...base,
      getAllEntityIds() {
        allIdsCalls++;
        return base.getAllEntityIds();
      },
    };

    const specs = Array.from({ length: 10 }, (_, i) => makePropertySpec(i, 'Code'));
    await validateIDS(makeDoc(specs), counting, modelInfo);

    expect(allIdsCalls).toBe(1);
  });
});

describe('validateIDS — requirement descriptions are formatted once per requirement', () => {
  it('calls translator.describeRequirement once per requirement, not per entity', async () => {
    let describeCalls = 0;
    const translator: TranslationService = {
      locale: 'en',
      t: (key: string) => key,
      describeFacet: () => 'facet',
      describeConstraint: () => 'constraint',
      describeFailure: () => 'failed',
      describeRequirement: () => {
        describeCalls++;
        return 'described';
      },
      getStatusText: (status) => status,
      getOptionalityText: (optionality) => optionality,
      getRelationDescription: (relation) => relation,
    };

    const spec = makePropertySpec(0, 'Code');
    await validateIDS(makeDoc([spec]), createMockAccessor(makeEntities(9)), modelInfo, {
      translator,
    });

    expect(describeCalls).toBe(1);
  });
});

describe('enumeration constraints — bounded rendering, unchanged matching', () => {
  const values = Array.from({ length: 50 }, (_, i) => `Value_${i}`);
  const enumeration: IDSEnumerationConstraint = { type: 'enumeration', values };

  it('truncates large enumerations in formatConstraint', () => {
    const formatted = formatConstraint(enumeration);
    expect(formatted).toContain('"Value_0"');
    expect(formatted).toContain('+40 more');
    expect(formatted).not.toContain('Value_49');
    // The whole point: bounded output regardless of enum size.
    expect(formatted.length).toBeLessThan(300);
  });

  it('truncates large enumerations in mismatch reasons', () => {
    const reason = getConstraintMismatchReason(enumeration, 'nope');
    expect(reason).toContain('+40 more');
    expect(reason.length).toBeLessThan(300);
  });

  it('keeps small enumerations fully rendered', () => {
    const small: IDSEnumerationConstraint = {
      type: 'enumeration',
      values: ['A', 'B', 'C'],
    };
    expect(formatConstraint(small)).toBe('one of ["A", "B", "C"]');
  });

  it('fast path preserves exact, case-insensitive, and numeric matching', () => {
    expect(matchConstraint(enumeration, 'Value_42')).toBe(true);
    expect(matchConstraint(enumeration, 'value_42')).toBe(false);
    expect(matchConstraint(enumeration, 'value_42', { caseInsensitive: true })).toBe(true);
    expect(matchConstraint(enumeration, 'Value_999')).toBe(false);

    const numeric: IDSEnumerationConstraint = {
      type: 'enumeration',
      values: ['1.5', '42'],
    };
    expect(matchConstraint(numeric, 42)).toBe(true);
    expect(matchConstraint(numeric, '42.0')).toBe(true); // numeric fallback
    expect(matchConstraint(numeric, 1.5)).toBe(true);
    expect(matchConstraint(numeric, 2)).toBe(false);
  });
});

describe('validateIDS — yields to the event loop during validation', () => {
  it('lets queued macrotasks (UI paints) run before validation completes', async () => {
    // Validation is pure CPU work; all its awaits resolve through
    // microtasks. Without explicit yields, a timer queued before the
    // run would only fire AFTER the whole validation finished — which
    // is exactly why the viewer's progress UI stayed frozen.
    const specs = Array.from({ length: 5 }, (_, i) => makePropertySpec(i, 'Code'));
    const accessor = createMockAccessor(makeEntities(200));

    let macrotaskRan = false;
    const timer = setTimeout(() => {
      macrotaskRan = true;
    }, 0);

    try {
      await validateIDS(makeDoc(specs), accessor, modelInfo, { yieldEveryMs: 0 });
      expect(macrotaskRan).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('reports filtering progress for large candidate scans', async () => {
    const entityCount = 20000; // > 8192 triggers incremental filtering progress
    const accessor = createMockAccessor(makeEntities(entityCount));
    const spec = makePropertySpec(0, 'Code');

    const filteringEvents: number[] = [];
    await validateIDS(makeDoc([spec]), accessor, modelInfo, {
      onProgress: (p) => {
        if (p.phase === 'filtering' && p.totalEntities > 0) {
          filteringEvents.push(p.entitiesProcessed);
        }
      },
    });

    // 20k candidates at 8192 granularity → events at 0, 8192, 16384.
    expect(filteringEvents.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...filteringEvents)).toBeGreaterThan(8000);
  });
});

describe('createCachedAccessor', () => {
  it('memoizes undefined results and keyed lookups', () => {
    const base = createMockAccessor(makeEntities(1));
    let typeCalls = 0;
    let attrCalls = 0;
    const counting: IFCDataAccessor = {
      ...base,
      getEntityType(expressId: number) {
        typeCalls++;
        return base.getEntityType(expressId);
      },
      getAttribute(expressId: number, name: string) {
        attrCalls++;
        return base.getAttribute(expressId, name);
      },
    };

    const cached = createCachedAccessor(counting);

    // Unknown entity → undefined, still memoized.
    expect(cached.getEntityType(999)).toBeUndefined();
    expect(cached.getEntityType(999)).toBeUndefined();
    expect(typeCalls).toBe(1);

    cached.getAttribute(1, 'Name');
    cached.getAttribute(1, 'Name');
    cached.getAttribute(1, 'Tag');
    expect(attrCalls).toBe(2);
  });

  it('only exposes optional methods the underlying accessor provides', () => {
    const base = createMockAccessor(makeEntities(1));
    const withoutOptionals: IFCDataAccessor = { ...base };
    delete withoutOptionals.getPredefinedTypeRaw;
    delete withoutOptionals.getAttributeNames;
    delete withoutOptionals.getAncestors;

    const cached = createCachedAccessor(withoutOptionals);
    expect(cached.getPredefinedTypeRaw).toBeUndefined();
    expect(cached.getAttributeNames).toBeUndefined();
    expect(cached.getAncestors).toBeUndefined();
  });
});
