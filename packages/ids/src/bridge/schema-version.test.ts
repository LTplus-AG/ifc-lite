/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `narrowSchemaVersion` is not the only place a raw `store.schemaVersion` gets
 * narrowed to a version with a bundled table: `@ifc-lite/data`'s descendant
 * resolver, which every `byType()` query goes through, has its own copy of the
 * mapping and cannot import this one (the dependency runs ids -> data).
 *
 * The two disagreed about IFC5 — this one answered IFC4X3, that one IFC4 —
 * which meant an IDS run and a `byType` query on the same IFC5 model resolved
 * a type against two different schemas. Pinned from this side, behaviourally:
 * whatever `narrowSchemaVersion` maps a raw string to, the resolver has to
 * expand the same way for the raw string and for the narrowed one.
 */

import { describe, it, expect } from 'vitest';
import { expandTypeNamesToDescendants } from '@ifc-lite/data';
import { narrowSchemaVersion } from './schema-version.js';

describe('narrowSchemaVersion and the descendant resolver agree', () => {
  // IfcSlab and IfcObject both discriminate: IFCSLABSTANDARDCASE is declared
  // only by the IFC4 table, and IFCPROJECT is an IfcObject in IFC2X3 but an
  // IfcContext from IFC4 on. A resolver that landed on a different version
  // than this function would answer differently for at least one of them.
  const PROBES = ['IfcSlab', 'IfcObject', 'IfcBuildingElement'];

  it.each(['IFC5', 'IFC4X3_ADD2', 'IFC4X3', 'IFC4', 'IFC2X3', 'nonsense', undefined])(
    'resolves %s the same way through both',
    (raw) => {
      const narrowed = narrowSchemaVersion(raw);
      for (const probe of PROBES) {
        expect(
          expandTypeNamesToDescendants([probe], raw),
          `${probe} @ ${String(raw)} -> ${narrowed}`,
        ).toEqual(expandTypeNamesToDescendants([probe], narrowed));
      }
    },
  );

  it('IFC5 lands on IFC4X3, not IFC4 — the disagreement this pins', () => {
    expect(narrowSchemaVersion('IFC5')).toBe('IFC4X3');
    // Anti-vacuity: the two versions really do answer differently here, so the
    // equality above is a claim and not a tautology.
    expect(expandTypeNamesToDescendants(['IfcObject'], 'IFC2X3')).toContain('IFCPROJECT');
    expect(expandTypeNamesToDescendants(['IfcObject'], 'IFC4X3')).not.toContain('IFCPROJECT');
  });
});
