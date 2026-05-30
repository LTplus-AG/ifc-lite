/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { getAttribute, getEntity, getPropertyValue } from '../src/doc/entity.js';
import {
  seedFromStep,
  guidToPath,
  type StepSeedSource,
} from '../src/snapshot/from-step.js';

function sampleSource(): StepSeedSource {
  return {
    header: { schema: 'IFC4', author: 'tester', timestamp: '2026-05-30T00:00:00Z' },
    entities: [
      {
        guid: '0aBcDeFgHiJkLmNoPqRsT1',
        ifcClass: 'IfcWallStandardCase',
        attributes: { Name: 'Wall A', Tag: '101' },
        psets: {
          Pset_WallCommon: {
            FireRating: { type: 'IfcLabel', value: 'EI60' },
            IsExternal: { type: 'IfcBoolean', value: true },
          },
        },
      },
      {
        guid: '0aBcDeFgHiJkLmNoPqRsT2',
        ifcClass: 'IfcSpace',
        attributes: { Name: 'Office' },
      },
      // No GUID → must be skipped, not seeded.
      { guid: '', ifcClass: 'IfcCartesianPoint' },
    ],
  };
}

describe('seedFromStep', () => {
  it('seeds GUID-keyed entities with class, attributes, and psets', () => {
    const doc = createCollabDoc();
    const result = seedFromStep(doc, sampleSource());

    expect(result.seeded).toBe(2);
    expect(result.skipped).toBe(1);

    const wallPath = guidToPath('0aBcDeFgHiJkLmNoPqRsT1');
    expect(getEntity(doc, wallPath)).toBeDefined();
    expect(getAttribute(doc, wallPath, 'Name')).toBe('Wall A');
    expect(getAttribute(doc, wallPath, 'Tag')).toBe('101');

    const fire = getPropertyValue(doc, wallPath, 'Pset_WallCommon', 'FireRating');
    expect(fire).toMatchObject({ type: 'IfcLabel', value: 'EI60' });
    const ext = getPropertyValue(doc, wallPath, 'Pset_WallCommon', 'IsExternal');
    expect(ext).toMatchObject({ type: 'IfcBoolean', value: true });

    // GUID-less entity was not created.
    expect(getEntity(doc, guidToPath(''))).toBeUndefined();
  });

  it('stamps the schema version from the header', () => {
    const doc = createCollabDoc();
    seedFromStep(doc, sampleSource());
    const entity = getEntity(doc, guidToPath('0aBcDeFgHiJkLmNoPqRsT2'));
    const meta = entity?.get('meta') as { get(k: string): unknown } | undefined;
    expect(meta?.get('schemaVersion')).toBe('ifc4');
    expect(meta?.get('ifcClass')).toBe('IfcSpace');
  });

  it('is idempotent — re-seeding the same source does not duplicate or throw', () => {
    const doc = createCollabDoc();
    const first = seedFromStep(doc, sampleSource());
    const second = seedFromStep(doc, sampleSource());
    expect(first.seeded).toBe(2);
    expect(second.seeded).toBe(2);
    // Entity count is stable across re-seeds.
    expect(doc.getMap('entities').size).toBe(2);
  });
});
