/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  __structural_schema_testing as S,
  STRUCTURAL_AMBIENT_DECLARATIONS,
} from './bridge-structural.js';

describe('bridge-structural — internal → public translation', () => {
  it('translateMember maps every camelCase source attribute to its IFC-PascalCase key', () => {
    const internal = {
      globalId: 'g-1', expressId: 42, type: 'IfcStructuralCurveMember',
      name: 'Beam A', description: 'desc', objectType: 'ot',
      predefinedType: 'RIGID_JOINED_MEMBER', thickness: 0.2,
      connectionGlobalIds: ['c-1', 'c-2'],
      activityGlobalIds: ['a-1'],
      analysisModelGlobalIds: ['m-1'],
    };
    const out = S.translateMember(internal);
    // Every MEMBER_FIELDS entry gets its own assertion (11 fields): a
    // mis-keyed camelKey/pascalKey pair anywhere in the table — not just in
    // the 4 fields previously asserted — must fail this test.
    expect(out.GlobalId).toBe('g-1');
    expect(out.ExpressId).toBe(42);
    expect(out.Type).toBe('IfcStructuralCurveMember');
    expect(out.Name).toBe('Beam A');
    expect(out.Description).toBe('desc');
    expect(out.ObjectType).toBe('ot');
    expect(out.PredefinedType).toBe('RIGID_JOINED_MEMBER');
    expect(out.Thickness).toBe(0.2);
    expect(out.ConnectionGlobalIds).toEqual(['c-1', 'c-2']);
    expect(out.ActivityGlobalIds).toEqual(['a-1']);
    expect(out.AnalysisModelGlobalIds).toEqual(['m-1']);
  });

  it('translateConnection nests AppliedCondition and passes its components through unchanged', () => {
    const out = S.translateConnection({
      globalId: 'g-2', expressId: 7, type: 'IfcStructuralPointConnection',
      memberGlobalIds: ['m-1'], activityGlobalIds: [], analysisModelGlobalIds: ['am-1'],
      appliedCondition: {
        expressId: 9, type: 'IfcBoundaryNodeCondition', name: 'Fixed',
        components: { TranslationalStiffnessX: true, RotationalStiffnessZ: true },
      },
    });
    const cond = out.AppliedCondition as { Type: string; Components: Record<string, unknown> };
    expect(cond.Type).toBe('IfcBoundaryNodeCondition');
    // Boolean-vs-number distinction from the extractor must survive translation
    // untouched: collapsing a fixed DOF to 1 would misreport a rigid support.
    expect(cond.Components.TranslationalStiffnessX).toBe(true);
  });

  it('translateActivity nests AppliedLoad, including a load configuration, without dropping truncated', () => {
    const out = S.translateActivity({
      globalId: 'g-3', expressId: 11, type: 'IfcStructuralCurveAction', kind: 'Action',
      groupGlobalIds: ['lg-1'],
      appliedLoad: {
        expressId: 20, type: 'IfcStructuralLoadConfiguration',
        components: {},
        configuration: {
          truncated: false,
          entries: [
            { value: { expressId: 21, type: 'IfcStructuralLoadLinearForce', components: { LinearForceZ: -100 } }, location: [96] },
            { value: { expressId: 22, type: 'IfcStructuralLoadLinearForce', components: { LinearForceZ: -100 } }, location: [192] },
          ],
        },
      },
    });
    const load = out.AppliedLoad as {
      Configuration: {
        Truncated: boolean;
        Entries: Array<{ Location?: number[]; Value?: { ExpressId: number; Type: string; Components: Record<string, unknown> } }>;
      };
    };
    expect(load.Configuration.Truncated).toBe(false);
    expect(load.Configuration.Entries).toHaveLength(2);
    // Distinct values per entry (different expressId/location/component) so a
    // dropped or duplicated mapping between entries — not just a wrong count
    // — fails: asserting only `Truncated`/`length` would stay green even if
    // both entries collapsed onto the first source object.
    expect(load.Configuration.Entries[0].Location).toEqual([96]);
    expect(load.Configuration.Entries[0].Value?.ExpressId).toBe(21);
    expect(load.Configuration.Entries[0].Value?.Components.LinearForceZ).toBe(-100);
    expect(load.Configuration.Entries[1].Location).toEqual([192]);
    expect(load.Configuration.Entries[1].Value?.ExpressId).toBe(22);
  });

  it('translateConfiguration forwards truncated=true rather than defaulting it away', () => {
    const out = S.translateConfiguration({ truncated: true, entries: [{ dropped: 'depth' }] });
    expect(out?.Truncated).toBe(true);
    const entries = out?.Entries as Array<{ Dropped?: string; Value?: unknown }>;
    expect(entries[0].Dropped).toBe('depth');
    expect(entries[0].Value).toBeUndefined();
  });

  it('translateData forwards LoadsTruncated straight off the extraction', () => {
    const out = S.translateData({
      hasStructural: true, loadsTruncated: true,
      analysisModels: [], members: [], connections: [], activities: [], loadGroups: [], resultGroups: [],
    });
    expect(out.LoadsTruncated).toBe(true);
    expect(out.HasStructural).toBe(true);
  });
});

describe('bridge-structural — schema hygiene', () => {
  it('declares recursively nested load configurations without erasing Value to unknown', () => {
    const declarations = STRUCTURAL_AMBIENT_DECLARATIONS.join('\n');
    expect(declarations).toContain('Value?: BimStructuralLoad');
    expect(declarations).not.toContain('Value?: unknown');
  });

  it('no duplicate keys across any struct (catches copy-paste errors in the schema table)', () => {
    for (const fields of [
      S.ANALYSIS_MODEL_FIELDS, S.MEMBER_FIELDS, S.CONNECTION_FIELDS,
      S.ACTIVITY_FIELDS, S.LOAD_GROUP_FIELDS, S.RESULT_GROUP_FIELDS,
    ]) {
      const pascal = fields.map(f => f.pascalKey);
      const camel = fields.map(f => f.camelKey);
      expect(new Set(pascal).size).toBe(pascal.length);
      expect(new Set(camel).size).toBe(camel.length);
    }
  });
});
