/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bodies given as IfcMappedItem (how Revit exports doors, windows and
 * equipment): read through the RepresentationMap with its MappingOrigin and
 * the item's MappingTarget, composed as Target · Origin like the repo's
 * geometry engine; nested maps followed with a depth and cycle guard; a
 * non-uniform scale refused as unreadable.
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { readBody } from '../src/model/outline.js';
import { ModelReader } from '../src/model/reader.js';
import { localOf } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

type Op = { axis1?: string; axis2?: string; origin?: [number, number, number]; scale?: number; axis3?: string; scale2?: number; scale3?: number };

/** A door in the east façade (IsExternal) whose only body is a mapped item; `inner` builds the mapped representation's items. */
const mappedDoor = (
  inner: (b: Extra, ctx: number) => number[],
  op: Op = {},
  originZ = 0,
  originPlacement?: (b: Extra) => number,
) => (b: Extra) => {
  const ctx = b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$)")},$,.MODEL_VIEW.,$)`);
  const rep = b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(${inner(b, ctx).map((i) => `#${i}`).join(',')}))`);
  const mapOrigin = originPlacement?.(b) ?? b.axis(0, 0, originZ);
  const map = b.add(`IFCREPRESENTATIONMAP(#${mapOrigin},#${rep})`);
  const pt = b.add(`IFCCARTESIANPOINT((${(op.origin ?? [0, 0, 0]).map((v) => v.toFixed(3)).join(',')}))`);
  const nonUniform = op.scale2 !== undefined || op.scale3 !== undefined;
  const target = b.add(
    `IFCCARTESIANTRANSFORMATIONOPERATOR3D${nonUniform ? 'NONUNIFORM' : ''}(${op.axis1 ?? '$'},${op.axis2 ?? '$'},#${pt},${op.scale ?? '$'},${op.axis3 ?? '$'}${nonUniform ? `,${op.scale2 ?? '$'},${op.scale3 ?? '$'}` : ''})`,
  );
  const item = b.add(`IFCMAPPEDITEM(#${map},#${target})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Tür gemappt',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 0)},#${b.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','MappedRepresentation',(#${item}))`)}))`)},$,2.1,1.,.DOOR.,$,$)`);
  b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  b.contain(b.storeys.eg.id, door);
};
/** A leaf 1 m x 0.1 m x 2.1 m whose base is at (x, 0, z) in the map's coordinates. */
const leaf = (x = 0, z = 0) => (b: Extra) => [b.rectExtrusion(x + 0.5, 0, 1, 0.1, 2.1, b.axis(0, 0, z), b.dir(0, 0, 1))];
const door = async (extra: (b: Extra) => void) => {
  const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
  return facts.candidates.find((c) => c.name === 'Tür gemappt')!;
};

describe('a body given as a mapped item', () => {
  it('is read: an exact level at the mapped body\'s bottom, moved by the MappingTarget', async () => {
    const d = await door(mappedDoor(leaf(), { origin: [0, 0, -0.2] }));
    expect(d).toMatchObject({ levelIsUpperEstimate: false, levelBasis: 'body-bottom' });
    expect(d.positionIsUncertain).toBeUndefined();
    expect(d.level).toBeCloseTo(499.8, 6);
  });

  it('composes Target · Origin: a map whose MappingOrigin sits 1 m up places its body 1 m up (as the geometry engine does)', async () => {
    const d = await door(mappedDoor(leaf(0, -1), {}, 1));
    expect(d.levelIsUpperEstimate).toBe(false);
    expect(d.level).toBeCloseTo(500, 6);
  });

  it('keeps a source-origin leaf at +1 m Z for identity target and +1 m MappingOrigin (#10503 review round 4)', async () => {
    const store = await parseStep(syntheticHouse({ extra: mappedDoor(leaf(), {}, 1) }));
    const reader = new ModelReader(store);
    const body = readBody(reader, reader.idsOfType('IFCDOOR').at(-1)!);
    expect(body.readable).toBe(1);
    expect(Math.min(...body.corners.map((point) => point[2]))).toBeCloseTo(1, 6);
  });

  it('composes a translated MappingOrigin before a rotated, translated MappingTarget (engine order)', async () => {
    const extra = (b: Extra) => mappedDoor(
      leaf(2),
      { axis1: `#${b.dir(0, 1, 0)}`, origin: [10, 0, 0] },
      0,
      (bb) => bb.axis(2, 0, 0),
    )(b);
    const d = await door(extra);
    expect(d.levelIsUpperEstimate).toBe(false);
    // Engine matrix T·O: source centre (2.5,0) + origin (2,0), rotated by T's
    // +90° X axis and translated (10,0), then placed at the door (20,5).
    expect(localOf(d.position).x).toBeCloseTo(30, 3);
    expect(localOf(d.position).y).toBeCloseTo(9.5, 3);
  });

  it('composes a rotated MappingOrigin before a translated MappingTarget (engine order)', async () => {
    const extra = (b: Extra) => mappedDoor(
      leaf(2),
      { origin: [10, 0, 0] },
      0,
      (bb) => bb.axis(0, 0, 0, bb.dir(0, 0, 1), bb.dir(0, 1, 0)),
    )(b);
    const d = await door(extra);
    expect(d.levelIsUpperEstimate).toBe(false);
    // MappingOrigin turns source +X into +Y; the target then adds (10,0).
    expect(localOf(d.position).x).toBeCloseTo(30, 3);
    expect(localOf(d.position).y).toBeCloseTo(7.5, 3);
  });

  it('applies the target\'s rotation: a leaf 2 m along the map\'s x lands 2 m along the door\'s y when Axis1 is +Y', async () => {
    const extra = (b: Extra) => mappedDoor(leaf(2), { axis1: `#${b.dir(0, 1, 0)}` })(b);
    const d = await door(extra);
    expect(d.levelIsUpperEstimate).toBe(false);
    // The leaf's centre at map (2.5, 0) lands at door (0, 2.5): local (20, 7.5).
    expect(localOf(d.position).x).toBeCloseTo(20, 3);
    expect(localOf(d.position).y).toBeCloseTo(7.5, 3);
  });

  it('a mirrored target (Axis1 = -X, Axis2 omitted: the +Y default projected) is read as a mirror', async () => {
    const extra = (b: Extra) => mappedDoor(leaf(2), { axis1: `#${b.dir(-1, 0, 0)}` })(b);
    const d = await door(extra);
    expect(d.levelIsUpperEstimate).toBe(false);
    // The leaf at map x 2..3 lands at door x -3..-2: 2.5 m west of the door's placement at local x 20.
    expect(localOf(d.position).x).toBeCloseTo(17.5, 3);
  });

  it('a nested map (a mapped item inside the mapped representation) is followed', async () => {
    const extra = (b: Extra) => mappedDoor((bb, ctx) => {
      const innerRep = bb.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(${leaf(0, -0.3)(bb).map((i) => `#${i}`).join(',')}))`);
      const innerMap = bb.add(`IFCREPRESENTATIONMAP(#${bb.axis(0, 0, 0)},#${innerRep})`);
      const op = bb.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${bb.add('IFCCARTESIANPOINT((0.,0.,0.))')},$,$)`);
      return [bb.add(`IFCMAPPEDITEM(#${innerMap},#${op})`)];
    })(b);
    const d = await door(extra);
    expect(d).toMatchObject({ levelIsUpperEstimate: false });
    expect(d.level).toBeCloseTo(499.7, 6);
  });

  it('a map that contains itself is unreadable, never a loop', async () => {
    const extra = (b: Extra) => {
      const ctx = b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$)")},$,.MODEL_VIEW.,$)`);
      // #rep holds #item, whose map points back at #rep: ids are reserved by writing the records in order.
      const op = b.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${b.add('IFCCARTESIANPOINT((0.,0.,0.))')},$,$)`);
      const origin = b.axis(0, 0, 0);
      const first = b.add('IFCCARTESIANPOINT((9.,9.,9.))'); // placeholder to learn the next ids
      const rep = first + 1;
      const map = first + 2;
      const item = first + 3;
      expect(b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','MappedRepresentation',(#${item}))`)).toBe(rep);
      expect(b.add(`IFCREPRESENTATIONMAP(#${origin},#${rep})`)).toBe(map);
      expect(b.add(`IFCMAPPEDITEM(#${map},#${op})`)).toBe(item);
      const d = b.add(`IFCDOOR(${b.guid()},$,'Tür gemappt',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 0)},#${b.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','MappedRepresentation',(#${item}))`)}))`)},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(d, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, d);
    };
    expect(await door(extra)).toMatchObject({ levelIsUpperEstimate: true });
  });

  it('a mapped representation over the leaf-work budget is wholly unreadable instead of expanded without bound', async () => {
    const d = await door(mappedDoor((b) => {
      const [item] = leaf()(b);
      return Array.from({ length: 5000 }, () => item!);
    }));
    expect(d.levelIsUpperEstimate).toBe(true);
  });

  it('a mapped chain beyond the depth cap is unreadable without throwing from model extraction', async () => {
    const d = await door(mappedDoor((b, ctx) => {
      let item = leaf()(b)[0]!;
      for (let depth = 0; depth < 9; depth++) {
        const rep = b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','MappedRepresentation',(#${item}))`);
        const map = b.add(`IFCREPRESENTATIONMAP(#${b.axis(0, 0, 0)},#${rep})`);
        const target = b.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${b.add('IFCCARTESIANPOINT((0.,0.,0.))')},$,$)`);
        item = b.add(`IFCMAPPEDITEM(#${map},#${target})`);
      }
      return [item];
    }));
    expect(d.levelIsUpperEstimate).toBe(true);
  });

  it('a non-uniform scale is refused as unreadable (an upper estimate), a uniform one is applied', async () => {
    expect(await door(mappedDoor(leaf(), { scale2: 2 }))).toMatchObject({ levelIsUpperEstimate: true });
    const scaled = await door(mappedDoor(leaf(0, -1), { scale: 0.5 }));
    expect(scaled).toMatchObject({ levelIsUpperEstimate: false });
    expect(scaled.level).toBeCloseTo(499.5, 6);
  });
});
