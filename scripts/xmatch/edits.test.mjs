/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #4955 edit primitives, on synthetic STEP text: the rectangle model is
 * read from both profile spellings, written back in the same spelling, and
 * the two halves of a split tile the original exactly. Pure — no wasm, no
 * built package — so it runs under the scripts/ catch-all.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexModel } from './edits.mjs';
import {
  ownedRectangleExtrusion,
  shrinkOwnedExtrusion,
  splitElementLength,
  thickenElement,
} from './rectangle-edits.mjs';
import {
  ownedPropertyValues,
  representationMapDigest,
  respecifyProperty,
} from './successor-edits.mjs';
import * as successorMutations from './successor-mutations.mjs';
import { parseStepFile, serializeStepFile, splitArgs } from './step-file.mjs';

const { mapDonors } = successorMutations;

function stepFile(body) {
  return `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${body}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** One wall with a named rectangle profile (#10) and one with a rotated
 *  four-corner polyline (#20), each owning its shape chain outright. */
const MODEL = stepFile(`
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCDIRECTION((0.,0.,1.));
#5=IFCCARTESIANPOINT((1.,0.5));
#6=IFCDIRECTION((1.,0.));
#7=IFCAXIS2PLACEMENT2D(#5,#6);
#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,4.,0.2);
#9=IFCEXTRUDEDAREASOLID(#8,#2,#4,3.);
#11=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#9));
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#11));
#10=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,#3,#12,$,$);
#21=IFCCARTESIANPOINT((0.,0.));
#22=IFCCARTESIANPOINT((3.,4.));
#23=IFCCARTESIANPOINT((2.6,4.3));
#24=IFCCARTESIANPOINT((-0.4,0.3));
#25=IFCPOLYLINE((#21,#22,#23,#24,#21));
#26=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#25);
#27=IFCEXTRUDEDAREASOLID(#26,#2,#4,2.);
#28=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#27));
#29=IFCPRODUCTDEFINITIONSHAPE($,$,(#28));
#20=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,#3,#29,$,$);
#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0cccccccccccccccccccccc',$,$,$,(#10,#20),#3);
#40=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#41=IFCPROPERTYSINGLEVALUE('Height',$,IFCREAL(2.5),$);
#42=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#43=IFCPROPERTYSET('0dddddddddddddddddddddd',$,'Pset_WallCommon',$,(#40,#41,#42));
#44=IFCRELDEFINESBYPROPERTIES('0eeeeeeeeeeeeeeeeeeeee',$,$,$,(#10),#43);
#59=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.,1.);
#53=IFCEXTRUDEDAREASOLID(#59,#2,#4,1.);
#54=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#53));
#55=IFCEXTRUDEDAREASOLID(#59,#2,#4,1.);
#56=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#55));
#57=IFCEXTRUDEDAREASOLID(#59,#2,#4,1.5);
#58=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#57));
#50=IFCREPRESENTATIONMAP(#2,#54);
#51=IFCREPRESENTATIONMAP(#2,#58);
#52=IFCREPRESENTATIONMAP(#2,#56);
`);

function load() {
  const file = parseStepFile(MODEL);
  return { file, index: indexModel(file) };
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('reads one rectangle model out of both profile spellings', () => {
  const { index } = load();
  const named = ownedRectangleExtrusion(index, 10);
  assert.deepEqual([named.a, named.b, named.depth], [2, 0.1, 3]);
  assert.deepEqual(named.centre, [1, 0.5]);
  assert.deepEqual(named.u, [1, 0]);

  const polygon = ownedRectangleExtrusion(index, 20);
  assert.ok(polygon, 'a rotated four-corner polyline is a rectangle');
  assert.ok(near(polygon.a, 2.5) && near(polygon.b, 0.25), `half-extents ${polygon.a} ${polygon.b}`);
  assert.ok(near(polygon.u[0], 0.6) && near(polygon.u[1], 0.8), 'unit axis along the first edge');
  assert.deepEqual(polygon.centre, [1.3, 2.15]);
});

test('thickening scales the shorter axis only and keeps the profile spelling', () => {
  const { file, index } = load();
  assert.equal(thickenElement(file, index, 10, 1.25), true);
  const profile = splitArgs(index.byId.get(8).args);
  assert.equal(profile[3], '4.');
  assert.equal(profile[4], '0.25');
  assert.equal(index.byId.get(8).type, 'IFCRECTANGLEPROFILEDEF');
  // The old placement (#7) may be shared: it is untouched, a new one is written.
  assert.notEqual(profile[2], '#7');
  assert.equal(index.byId.get(7).args, '#5,#6');

  assert.equal(thickenElement(file, index, 20, 1.25), true);
  const after = ownedRectangleExtrusion(index, 20);
  assert.ok(near(after.a, 2.5) && near(after.b, 0.3125), 'polygon short axis 0.25 -> 0.3125');
  assert.equal(index.byId.get(26).type, 'IFCARBITRARYCLOSEDPROFILEDEF');
  assert.equal(index.byId.get(25).args, '(#21,#22,#23,#24,#21)', 'old polyline untouched');
});

test('a split yields two half-length products that tile the original', () => {
  const { file, index } = load();
  const before = ownedRectangleExtrusion(index, 20);
  const cloneId = splitElementLength(file, index, 20, ['left', 'right']);
  assert.ok(cloneId, 'eligible');
  const clone = index.byId.get(cloneId);
  assert.equal(clone.type, 'IFCWALL');
  assert.equal(splitArgs(clone.args)[2], "'right'");
  assert.equal(splitArgs(index.byId.get(20).args)[2], "'left'");
  // Enrolled in the containment list, same placement, private shape.
  assert.match(index.byId.get(30).args, new RegExp(`\\(#10,#20,#${cloneId}\\)`));
  assert.equal(splitArgs(clone.args)[5], '#3');
  assert.notEqual(splitArgs(clone.args)[6], '#29');

  // Re-read the file as written: the reverse-reference index is built once
  // per model and knows nothing about emitted statements, and the head
  // revision the harness scores is the serialized text, not the live index.
  const reread = indexModel(parseStepFile(serializeStepFile(file)));
  const left = ownedRectangleExtrusion(reread, 20);
  const right = ownedRectangleExtrusion(reread, cloneId);
  assert.ok(left && right, 'both halves own one rectangle extrusion outright');
  for (const half of [left, right]) {
    assert.ok(near(half.a, before.a / 2), 'long axis halved');
    assert.ok(near(half.b, before.b), 'short axis kept');
    assert.ok(near(half.depth, before.depth), 'depth kept');
  }
  // Centres sit a quarter length either side of the old centre along u, so
  // the two halves' extents along u meet exactly at the old centre.
  const along = (half) =>
    (half.centre[0] - before.centre[0]) * before.u[0] + (half.centre[1] - before.centre[1]) * before.u[1];
  assert.ok(near(along(left), -before.a / 2) && near(along(right), before.a / 2), 'quarter-length shifts');
  const across = (half) =>
    (half.centre[0] - before.centre[0]) * before.v[0] + (half.centre[1] - before.centre[1]) * before.v[1];
  assert.ok(near(across(left), 0) && near(across(right), 0), 'no shift across');
});

test('shrinking keeps the base plane and scales every axis', () => {
  const { file, index } = load();
  const owned = ownedRectangleExtrusion(index, 10);
  shrinkOwnedExtrusion(file, index, owned, 0.3);
  const after = ownedRectangleExtrusion(index, 10);
  assert.ok(near(after.a, 0.6) && near(after.b, 0.03) && near(after.depth, 0.9));
  assert.deepEqual(after.centre, owned.centre);
});

test('a respecified property keeps its name and type and changes its value', () => {
  const { index } = load();
  const rows = ownedPropertyValues(index, 10);
  assert.deepEqual(
    rows.map((row) => row.name),
    ['FireRating', 'Height', 'IsExternal'],
  );
  assert.deepEqual(ownedPropertyValues(index, 20), [], 'the set relates #10 alone');
  for (const [id, expected] of [
    [40, "'FireRating',$,IFCLABEL('REI60 (rev B)'),$"],
    [41, "'Height',$,IFCREAL(3.75),$"],
    [42, "'IsExternal',$,IFCBOOLEAN(.F.),$"],
  ]) {
    assert.equal(respecifyProperty(index, id), true);
    assert.equal(index.byId.get(id).args, expected);
  }
});

test('the map digest sees a copy as equal and a different shape as different', () => {
  const { index } = load();
  assert.equal(representationMapDigest(index, 50), representationMapDigest(index, 52));
  assert.notEqual(representationMapDigest(index, 50), representationMapDigest(index, 51));
});

function mappedParametricFile() {
  return parseStepFile(stepFile(`
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.8,4.8);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,4.8);
#10=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#5));
#11=IFCREPRESENTATIONMAP(#2,#10);
#24=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.75,0.75);
#25=IFCEXTRUDEDAREASOLID(#24,#2,#3,0.75);
#30=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#25));
#31=IFCREPRESENTATIONMAP(#2,#30);
#101=IFCMAPPEDITEM(#11,$);
#102=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#101));
#103=IFCPRODUCTDEFINITIONSHAPE($,$,(#102));
#100=IFCWINDOW('0aaaaaaaaaaaaaaaaaaaaa',$,'Wide window',$,$,$,#103,$,$,$,$);
#201=IFCMAPPEDITEM(#31,$);
#202=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#201));
#203=IFCPRODUCTDEFINITIONSHAPE($,$,(#202));
#200=IFCWINDOW('0bbbbbbbbbbbbbbbbbbbbb',$,'Narrow window',$,$,$,#203,$,$,$,$);
`));
}

const box = (size) => ({ min: [0, 0, 0], max: [size, size, size] });

test('canonical bounds reject a parametric 4.8 m / 0.75 m donor pair (#4989)', () => {
  const file = mappedParametricFile();
  const bounds = new Map([
    [100, box(4.8)],
    [200, box(0.75)],
  ]);

  assert.deepEqual([...mapDonors(indexModel(file), [100, 200], bounds)], []);
});

test('mapped donors fail closed without canonical geometry bounds (#4989)', () => {
  const file = mappedParametricFile();
  assert.deepEqual([...mapDonors(indexModel(file), [100, 200], new Map([[100, box(1)]]))], []);
});

test('mapped donors remain eligible when canonical bounds are comparable (#4989)', () => {
  const file = mappedParametricFile();
  const bounds = new Map([
    [100, box(1)],
    [200, box(1.5)],
  ]);

  assert.deepEqual([...mapDonors(indexModel(file), [100, 200], bounds)], [
    [100, 31],
    [200, 11],
  ]);
  assert.deepEqual(
    [...mapDonors(indexModel(file), [100, 200], bounds, new Set(['100:31']))],
    [[200, 11]],
  );
});

test('post-mutation bounds reject a transformed donor that passed the base prefilter (#4989)', () => {
  const key = {
    elements: [{ base: 100, kind: 'swapped', head: [900], detail: { donorMap: 31 } }],
  };
  const base = [{ ref: 100, aabb: box(1) }];
  const head = [{ ref: 900, aabb: box(3) }];

  assert.equal(typeof successorMutations.incomparableSwaps, 'function');
  assert.deepEqual(successorMutations.incomparableSwaps(key, base, head), [
    { base: 100, donorMap: 31, head: 900 },
  ]);
});
