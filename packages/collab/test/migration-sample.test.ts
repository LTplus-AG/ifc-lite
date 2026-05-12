/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import { createEntity, getAttribute, setAttribute } from '../src/doc/entity.js';
import {
  getSchemaVersion,
  migrateSchema,
  setSchemaVersion,
} from '../src/doc/schema-version.js';
import { installIfc4ToIfc4x3Migration } from '../src/doc/migration-ifc4-to-ifc4x3.js';

describe('IFC4 → IFC4X3 sample migration', () => {
  it('renames Pset_<X>::<key> attributes into the bsi::ifc::v5a:: namespace', () => {
    installIfc4ToIfc4x3Migration();

    const doc = createCollabDoc();
    setSchemaVersion(doc, 'ifc4');
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Pset_WallCommon::FireRating', 'EI60');
    setAttribute(doc, 'wall', 'Pset_WallCommon::IsExternal', true);
    setAttribute(doc, 'wall', 'OtherKey', 'untouched');

    expect(migrateSchema(doc, 'ifc4', 'ifc4x3')).toBe(true);
    expect(getSchemaVersion(doc)).toBe('ifc4x3');

    expect(getAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_WallCommon::FireRating')).toBe('EI60');
    expect(getAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_WallCommon::IsExternal')).toBe(true);
    // Unrelated attribute survives.
    expect(getAttribute(doc, 'wall', 'OtherKey')).toBe('untouched');
    // Old prefix is gone.
    expect(getAttribute(doc, 'wall', 'Pset_WallCommon::FireRating')).toBeUndefined();
  });
});
