/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The relationship gate's type lists are generated with each registry, so
// building them must not look a registry up (a lookup is what decodes one in a
// bundle). Every registry lookup here throws: the lists still have to come back
// complete, and an unknown version still has to fail with the lookup's error.

import { describe, it, expect, vi } from 'vitest';

vi.mock('./generated/schema-registry-by-version.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./generated/schema-registry-by-version.js')>();
  return {
    ...original,
    getSchemaRegistryForVersion: vi.fn((version: string) => {
      throw new Error(`registry lookup for ${version}`);
    }),
  };
});

const { getConcreteRelationshipTypes } = await import('./relationship-schema-slots.js');

describe('concrete relationship types without a registry lookup', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s resolves from the generated list', (version) => {
    const types = getConcreteRelationshipTypes(version);
    expect(types.has('IFCRELCONTAINEDINSPATIALSTRUCTURE')).toBe(true);
    expect(types.has('IFCRELDEFINESBYPROPERTIES')).toBe(true);
    expect(types.has('IFCRELATIONSHIP')).toBe(false);
  });

  it('an unknown version still fails through the registry lookup', () => {
    expect(() => getConcreteRelationshipTypes('IFC5' as never)).toThrow(/registry lookup for IFC5/);
  });
});
