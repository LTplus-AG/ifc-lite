/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createCollabDoc } from '../src/doc/schema.js';
import {
  getSchemaVersion,
  migrateSchema,
  registerSchemaMigration,
  setSchemaVersion,
} from '../src/doc/schema-version.js';
import { setAttribute, createEntity, getAttribute } from '../src/doc/entity.js';

describe('schema-version helpers', () => {
  it('defaults to "unknown" and round-trips set/get', () => {
    const doc = createCollabDoc();
    expect(getSchemaVersion(doc)).toBe('unknown');
    setSchemaVersion(doc, 'ifc4x3');
    expect(getSchemaVersion(doc)).toBe('ifc4x3');
    setSchemaVersion(doc, 'ifc5');
    expect(getSchemaVersion(doc)).toBe('ifc5');
  });

  it('migrateSchema applies a registered migration and bumps version', () => {
    const doc = createCollabDoc();
    setSchemaVersion(doc, 'ifc4');
    createEntity(doc, 'wall');
    setAttribute(doc, 'wall', 'Pset_WallCommon::FireRating', 'EI60');

    registerSchemaMigration({
      from: 'ifc4',
      to: 'ifc4x3',
      apply(d) {
        // Toy migration: rename the attribute prefix.
        const ents = d.getMap('entities');
        ents.forEach((entUntyped) => {
          const ent = entUntyped as import('yjs').Map<unknown>;
          const attrs = ent.get('attributes') as import('yjs').Map<unknown> | undefined;
          if (!attrs) return;
          attrs.forEach((value, key) => {
            if (key.startsWith('Pset_WallCommon::')) {
              attrs.set(`bsi::ifc::v5a::Pset_WallCommon::${key.split('::').slice(1).join('::')}`, value);
              attrs.delete(key);
            }
          });
        });
      },
    });

    expect(migrateSchema(doc, 'ifc4', 'ifc4x3')).toBe(true);
    expect(getSchemaVersion(doc)).toBe('ifc4x3');
    expect(
      getAttribute(doc, 'wall', 'bsi::ifc::v5a::Pset_WallCommon::FireRating'),
    ).toBe('EI60');
    expect(getAttribute(doc, 'wall', 'Pset_WallCommon::FireRating')).toBeUndefined();
  });

  it('migrateSchema is a no-op when version does not match', () => {
    const doc = createCollabDoc();
    setSchemaVersion(doc, 'ifc5');
    expect(migrateSchema(doc, 'ifc4', 'ifc4x3')).toBe(false);
  });
});
