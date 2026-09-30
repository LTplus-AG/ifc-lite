/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The picker's section maths (#6232 D2): every kind's default is a section the
 * builders accept, a kind switched onto any outer size is still valid, each
 * outline spans exactly the extent the builders and the mesher use, and a
 * profile entity reads back as the section that wrote it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileSectionExtent, type ProfileSection, type ProfileSectionType } from '@ifc-lite/create';
import { DEFAULT_SECTIONS, PROFILE_FIELDS, PROFILE_KINDS, sectionOfType, sectionProblem, sectionWithExtent, withDimension } from './profile-kinds';
import { sectionOutline, sectionPath } from './profile-outline';
import { sectionFromProfile } from './read-profile';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';

const SHAPES = PROFILE_KINDS.filter((kind): kind is Exclude<ProfileSectionType, 'Rectangle'> => kind !== 'Rectangle');
const box = (points: readonly (readonly [number, number])[]) => {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), (Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
};

describe('profile kinds (#6232 D2)', () => {
  it('lists the rectangle and the eight shapes, each with its mandatory fields', () => {
    assert.deepEqual([...PROFILE_KINDS], ['Rectangle', 'I', 'L', 'T', 'U', 'C', 'Circle', 'RectangleHollow', 'CircleHollow']);
    assert.deepEqual(PROFILE_FIELDS.I.map((f) => f.name), ['OverallWidth', 'OverallDepth', 'WebThickness', 'FlangeThickness']);
    assert.deepEqual(PROFILE_FIELDS.CircleHollow.map((f) => f.name), ['Radius', 'WallThickness']);
  });

  for (const kind of SHAPES) {
    it(`${kind}: the default section is one the builders accept, and its dimensions are exactly its fields`, () => {
      assert.equal(sectionProblem(DEFAULT_SECTIONS[kind]), null);
      const { Type: _type, ...dims } = DEFAULT_SECTIONS[kind] as ProfileSection & Record<string, number>;
      assert.deepEqual(Object.keys(dims).sort(), PROFILE_FIELDS[kind].map((f) => f.name).sort());
    });

    it(`${kind}: taken to any outer size stays valid, and reports that size back`, () => {
      for (const extent of [[0.05, 0.05], [0.3, 0.5], [0.12, 0.02], [1.2, 0.6], [0.02, 0.4]] as const) {
        const section = sectionWithExtent(kind, extent);
        assert.equal(sectionProblem(section), null, `${kind} at ${extent}: ${sectionProblem(section)}`);
        const [across, up] = profileSectionExtent(section);
        if (kind === 'Circle' || kind === 'CircleHollow') assert.equal(across, Math.min(...extent));
        else assert.deepEqual([across, up], [...extent]);
      }
    });

    it(`${kind}: the outline is centred and spans the extent the builders report`, () => {
      const section = DEFAULT_SECTIONS[kind];
      const outline = sectionOutline(section)!;
      const [w, h, cx, cy] = box(outline.outer);
      const [across, up] = profileSectionExtent(section);
      assert.ok(Math.abs(w - across) < 1e-9 && Math.abs(h - up) < 1e-9, `${kind} outline ${w} x ${h} vs ${across} x ${up}`);
      assert.ok(Math.abs(cx) < 1e-9 && Math.abs(cy) < 1e-9, `${kind} is centred on its bounding box`);
      if (outline.inner) assert.equal(outline.inner.length, outline.outer.length, 'a bore has a point for each of the outside');
      assert.match(sectionPath(section, 64)!, /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z/);
    });
  }

  it('a hollow section draws its bore as a second ring', () => {
    assert.ok(sectionOutline(DEFAULT_SECTIONS.RectangleHollow)!.inner);
    assert.ok(sectionOutline(DEFAULT_SECTIONS.CircleHollow)!.inner);
    assert.equal(sectionOutline(DEFAULT_SECTIONS.I)!.inner, undefined);
    assert.equal((sectionPath(DEFAULT_SECTIONS.CircleHollow, 64)!.match(/Z/g) ?? []).length, 2);
  });

  it('an I is the two flanges and the web: 12 corners, the web centred', () => {
    const outline = sectionOutline({ Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 })!.outer;
    assert.equal(outline.length, 12);
    assert.deepEqual(outline.filter(([x]) => Math.abs(x) === 0.005).length, 4);
  });

  it('refuses walls and webs that do not fit', () => {
    assert.match(sectionProblem(withDimension(DEFAULT_SECTIONS.I, 'WebThickness', 0.5))!, /WebThickness must be less than OverallWidth/);
    assert.match(sectionProblem(withDimension(DEFAULT_SECTIONS.CircleHollow, 'WallThickness', 0.2))!, /WallThickness must be less than Radius/);
    assert.match(sectionProblem(withDimension(DEFAULT_SECTIONS.L, 'Width', -1))!, /positive/);
  });

  it('a kind remembers only its own fields', () => {
    assert.deepEqual(sectionOfType('I', { OverallWidth: 0.3, Radius: 9, Bogus: 1 }), { ...DEFAULT_SECTIONS.I, OverallWidth: 0.3 });
  });

  it('a profile entity reads back in metres, in any length unit', () => {
    assert.deepEqual(sectionFromProfile('IFCISHAPEPROFILEDEF', ['.AREA.', null, '#1', 200, 400, 10, { real: 16 }], 0.001),
      { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016 });
    assert.equal(sectionFromProfile('IfcCircleProfileDef', ['.AREA.', null, '#1', 0.15], 1)?.Type, 'Circle', 'a mixed-case class reads too');
    assert.equal(sectionFromProfile('IFCARBITRARYCLOSEDPROFILEDEF', ['.AREA.', null, '#1'], 1), null);
    assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', ['.AREA.', null, '#1', 0.2, 0.4, 0, 0.01], 1), null, 'a zero web is not a section');
  });
});

// Optional tails differ by schema; read the actual registry, not a guessed index.
describe('schema-aware section fidelity (#6232/#6532)', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`${schema}: keeps an I fillet and refuses populated unsupported geometry`, () => {
      const registry = getSchemaRegistryForVersion(schema);
      const fields = registry.entities.IfcIShapeProfileDef.allAttributes!;
      const values: Record<string, unknown> = {
        ProfileType: '.AREA.', OverallWidth: 200, OverallDepth: 400,
        WebThickness: 10, FlangeThickness: 16, FilletRadius: { real: 8 },
      };
      const attrs = fields.map((field) => values[field.name] ?? null);
      assert.deepEqual(sectionFromProfile('IFCISHAPEPROFILEDEF', attrs, 0.001, schema),
        { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.4, WebThickness: 0.01, FlangeThickness: 0.016, FilletRadius: 0.008 });
      const extra = fields.findIndex((field) => field.name === 'FlangeSlope');
      if (extra >= 0) {
        attrs[extra] = 0.1;
        assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', attrs, 0.001, schema), null);
      }
    });
  }
  it('keeps zero supported radii and refuses malformed or excess geometry', () => {
    const attrs = ['.AREA.', null, null, 0.2, 0.4, 0.01, 0.016, 0, null, null];
    assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', attrs, 1)?.Type, 'I');
    const bad = [...attrs]; bad[7] = -0.001;
    assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', bad, 1), null);
    assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', [...attrs, 123], 1), null);
    assert.equal(sectionFromProfile('IFCISHAPEPROFILEDEF', attrs, 1, 'IFCX'), null);
  });
});
