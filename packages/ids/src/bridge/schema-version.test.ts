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
  // Each probe has to separate the version this function returns from the ones
  // it does not, or the equality below is green for a resolver that landed
  // somewhere else. IfcSlab and IfcObject separate IFC2X3 from the rest
  // (IFCSLABSTANDARDCASE is declared only by the IFC4 table; IFCPROJECT is an
  // IfcObject in IFC2X3 and an IfcContext from IFC4 on). Neither separates
  // IFC4 from IFC4X3, and IFC5 mapping to IFC4 instead of IFC4X3 is the exact
  // regression this file exists to pin — so IfcPositioningElement is here for
  // that pair alone: IFC4X3 re-parented IfcGrid under it, IFC4 leaves IfcGrid
  // under IfcProduct. Sweeping all 1159 bundled entity names, it is the ONLY
  // name whose expansion differs between IFC4 and IFC4X3, so dropping it
  // leaves that direction unpinned entirely.
  const PROBES = ['IfcSlab', 'IfcObject', 'IfcBuildingElement', 'IfcPositioningElement'];

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
    // And specifically for the pair that was wrong: IFC4 is not merely another
    // name for IFC4X3 here, so the it.each above fails if IFC5 lands on IFC4.
    expect(expandTypeNamesToDescendants(['IfcPositioningElement'], 'IFC4X3')).toContain('IFCGRID');
    expect(expandTypeNamesToDescendants(['IfcPositioningElement'], 'IFC4')).not.toContain(
      'IFCGRID',
    );
  });
});
