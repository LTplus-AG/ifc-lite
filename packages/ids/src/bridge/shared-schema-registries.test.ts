/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The resource-classification predicate reads the parser's IFC4 and IFC4X3
 * registries instead of `@ifc-lite/codegen`'s copies, so a bundle decodes
 * each schema once. The copies come from the same generation; this pins that
 * the hierarchy facts the predicate reads (every entity's inheritance chain)
 * are identical in both, and that the IFC4 one is the parser's pin itself.
 */

import { describe, it, expect } from 'vitest';
import { getSchemaRegistryForVersion, SCHEMA_REGISTRY } from '@ifc-lite/parser';
import * as IFC4_SCHEMA from '@ifc-lite/codegen/ifc4';
import * as IFC4X3_SCHEMA from '@ifc-lite/codegen/ifc4x3';

const chains = (entities: Record<string, { inheritanceChain?: string[] }>) =>
  JSON.stringify(Object.entries(entities).map(([name, e]) => [name, e.inheritanceChain ?? null]));

describe('shared schema registries', () => {
  it('the parser IFC4 registry carries the same hierarchy as the codegen IFC4 copy', () => {
    expect(getSchemaRegistryForVersion('IFC4')).toBe(SCHEMA_REGISTRY);
    expect(chains(getSchemaRegistryForVersion('IFC4').entities)).toBe(chains(IFC4_SCHEMA.SCHEMA_REGISTRY.entities));
  });

  it('the parser IFC4X3 registry carries the same hierarchy as the codegen IFC4X3 copy', () => {
    expect(chains(getSchemaRegistryForVersion('IFC4X3').entities)).toBe(chains(IFC4X3_SCHEMA.SCHEMA_REGISTRY.entities));
  });
});
