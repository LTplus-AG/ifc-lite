/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';
import { readRhino3dm } from '../index.js';
import { craft, drawnTriangles, translation, type AttributeSpec, type Craft } from '../../test-support/craft.js';

/**
 * How a block member's "from parent" colour and material resolve (#9987).
 *
 * The expected values come from `ON_3dmObjectAttributes::ApplyParentalControl`
 * in openNURBS 8.x, the function Rhino itself uses, run over all 144
 * combinations of a member's and an instance's colour and material sources.
 * What it does with a member's attributes:
 *
 * - a "by parent" MATERIAL is overwritten with the instance's resolved
 *   material index, and the member's material source becomes
 *   `MaterialFromObject`. Nothing afterwards can tell the member from one that
 *   owned that material, so the inherited material decides both the colour
 *   under `ColorFromMaterial` and the transparency under every source;
 * - a "by parent" COLOUR is replaced by the instance's, a "by layer" instance
 *   colour resolving to that instance's layer colour;
 * - every other source is left alone, the member's layer index included: the
 *   layer index is never rewritten, so `ColorFromLayer` on a member always
 *   means the member's own layer and never the instance's.
 *
 * `docs/architecture/rhino-3dm-import.md` carries the table and the citations.
 */

const unit = (c: Craft) => c.box([0, 0, 0], [1, 1, 1]);
/** Colour channels back as the 0-255 integers the file stores, so a row reads like the file. */
const bytes255 = (color: readonly number[]) => color.map(v => Math.round(v * 255));
/** Where the instance sits, far enough out that a member's own x stays legible in its origin. */
const PLACED_AT = 100;

describe('a block member resolved against the instance placing it', () => {
  /**
   * One instance with a red object colour and a blue, half-transparent material,
   * placing eight members that differ only in their two sources.
   */
  function sources(c: Craft) {
    const memberLayer = c.layer('Member', { color: [0, 128, 0, 255] });
    const instanceLayer = c.layer('Instance', { color: [255, 255, 0, 255] });
    const glass = c.material('Glass', [0, 0, 255, 255], 0.5);
    const solid = c.material('Solid', [255, 255, 0, 255]);
    const member: AttributeSpec = { layer: memberLayer, color: [255, 255, 255, 255] };
    // Member i is a box at x = i, so its mesh origin says which row it is whichever path drew it.
    const block = c.block('Sources', Array.from({ length: 8 }, (_, i) => c.box([i, 0, 0], [i + 1, 1, 1])), [
      { ...member, colorSource: 'ColorFromObject', materialSource: 'MaterialFromLayer' },
      { ...member, colorSource: 'ColorFromObject', materialSource: 'MaterialFromParent' },
      { ...member, colorSource: 'ColorFromLayer', materialSource: 'MaterialFromLayer' },
      { ...member, colorSource: 'ColorFromLayer', materialSource: 'MaterialFromParent' },
      { ...member, colorSource: 'ColorFromMaterial', material: solid, materialSource: 'MaterialFromObject' },
      { ...member, colorSource: 'ColorFromMaterial', materialSource: 'MaterialFromParent' },
      { ...member, colorSource: 'ColorFromParent', materialSource: 'MaterialFromLayer' },
      { ...member, colorSource: 'ColorFromParent', materialSource: 'MaterialFromParent' },
    ]);
    c.addInstance(block, translation(PLACED_AT, 0, 0), {
      layer: instanceLayer, color: [255, 0, 0, 255], colorSource: 'ColorFromObject',
      material: glass, materialSource: 'MaterialFromObject',
    });
  }

  // The instance draws itself red at the alpha of its own material: 1 - 0.5.
  const instanceColor = [255, 0, 0, 128];

  test.each([
    ['ColorFromObject + MaterialFromLayer', 0, [255, 255, 255, 255], 'its own object colour, its layer naming no material'],
    ['ColorFromObject + MaterialFromParent', 1, [255, 255, 255, 128], "its own object colour at the instance material's transparency"],
    ['ColorFromLayer + MaterialFromLayer', 2, [0, 128, 0, 255], "its OWN layer's colour, not the instance's layer"],
    ['ColorFromLayer + MaterialFromParent', 3, [0, 128, 0, 128], "its own layer's colour at the instance material's transparency"],
    ['ColorFromMaterial + MaterialFromObject', 4, [255, 255, 0, 255], 'the diffuse colour of the material it names'],
    ['ColorFromMaterial + MaterialFromParent', 5, [0, 0, 255, 128], "the INSTANCE MATERIAL's diffuse colour, not the instance's object colour"],
    ['ColorFromParent + MaterialFromLayer', 6, instanceColor, "the instance's resolved colour"],
    ['ColorFromParent + MaterialFromParent', 7, instanceColor, "the instance's resolved colour"],
  ])('%s draws %j: %s', async (_sources, member, expected) => {
    // Baked, so every member is a mesh of its own, found by the x its box was built at.
    const result = await readRhino3dm(await craft(sources), { bakeInstances: true });
    expect(result.meshes).toHaveLength(8);
    const drawn = result.meshes.find(m => Math.round(m.origin[0]) === PLACED_AT + member);
    expect(drawn && bytes255(drawn.color)).toEqual(expected);
  });

  test('a member the instance material colours or fades is baked; both modes draw the same', async () => {
    const file = await craft(sources);
    const instanced = await readRhino3dm(file), baked = await readRhino3dm(file, { bakeInstances: true });
    // A definition mesh holds one colour or none, and neither can carry a colour that comes from
    // the instance's material, so the three members that inherit a material are baked per placement.
    expect(instanced.definitions[0].meshes.map(m => m.color && bytes255(m.color))).toEqual([
      [255, 255, 255, 255], [0, 128, 0, 255], [255, 255, 0, 255], null, null,
    ]);
    expect(instanced.meshes.map(m => bytes255(m.color))).toEqual([
      [255, 255, 255, 128], [0, 128, 0, 128], [0, 0, 255, 128],
    ]);
    expect(instanced.instances.map(i => bytes255(i.color))).toEqual([instanceColor]);
    // 8 boxes of 12 triangles, counted once however they are split between the two paths.
    expect([drawnTriangles(instanced), drawnTriangles(baked)]).toEqual([96, 96]);
    // Members 1, 3 and 5, drawn where the instance placed them.
    expect(instanced.meshes.map(m => Math.round(m.origin[0]))).toEqual([PLACED_AT + 1, PLACED_AT + 3, PLACED_AT + 5]);
  });
});

test('at top level, with no instance to inherit from, both "from parent" sources fall back to the layer', async () => {
  // openNURBS: "if no parent, treat as color_from_layer", and the same for material_from_parent.
  const build = (c: Craft) => {
    const glass = c.material('Glass', [0, 0, 255, 255], 0.5);
    const tinted = c.layer('Tinted', { color: [0, 128, 0, 255], material: glass });
    const plain = c.layer('Plain', { color: [255, 255, 0, 255] });
    c.addMesh(unit(c), { layer: plain, colorSource: 'ColorFromParent', color: [255, 0, 0, 255] });
    c.addMesh(unit(c), { layer: tinted, colorSource: 'ColorFromObject', color: [255, 0, 0, 255], materialSource: 'MaterialFromParent' });
  };
  const result = await readRhino3dm(await craft(build));
  // The first takes its own layer's colour, not its unused object colour.
  expect(bytes255(result.meshes[0].color)).toEqual([255, 255, 0, 255]);
  // The second's material falls back to its layer's, whose transparency then fades its colour.
  expect(bytes255(result.meshes[1].color)).toEqual([255, 0, 0, 128]);
  // Its name follows the same fallback, so the properties card shows the layer's material.
  const rhinoSet = result.entities[1].propertySets.find(set => set.name === 'Rhino');
  expect(rhinoSet?.properties).toContainEqual(['Material', 'Glass']);
});

describe('nested blocks', () => {
  /**
   * The nested-block example from the Rhino 8 object-properties help page: a box
   * whose display colour is By Parent sits in Block A, which sits in Block B.
   * Run through openNURBS, the box ends up `ColorFromObject` with Block A's
   * layer colour when A is By Layer, and with Block B's object colour when A is
   * By Parent, which is what the help page says.
   */
  const build = (aByParent: boolean) => (c: Craft) => {
    const boxLayer = c.layer('Box', { color: [0, 128, 0, 255] });
    const layerA = c.layer('A', { color: [255, 255, 0, 255] });
    const layerB = c.layer('B', { color: [0, 255, 255, 255] });
    const blockA = c.block('A', [unit(c)], [{ layer: boxLayer, colorSource: 'ColorFromParent' }]);
    const blockB = c.block('B', [c.reference(blockA)], [
      { layer: layerA, colorSource: aByParent ? 'ColorFromParent' : 'ColorFromLayer' },
    ]);
    c.addInstance(blockB, undefined, { layer: layerB, color: [255, 0, 255, 255], colorSource: 'ColorFromObject' });
  };

  test('"by parent" follows the direct parent: Block A by layer gives the box Block A\'s layer colour', async () => {
    const result = await readRhino3dm(await craft(build(false)), { bakeInstances: true });
    expect(bytes255(result.meshes[0].color)).toEqual([255, 255, 0, 255]);
  });

  test("Block A by parent too passes the grandparent's colour down to the box", async () => {
    const result = await readRhino3dm(await craft(build(true)), { bakeInstances: true });
    expect(bytes255(result.meshes[0].color)).toEqual([255, 0, 255, 255]);
  });

  test('an inherited material passes down through a nested block as well', async () => {
    const build = (c: Craft) => {
      const glass = c.material('Glass', [0, 0, 255, 255], 0.5);
      const blockA = c.block('A', [unit(c)], [{ color: [255, 255, 255, 255], materialSource: 'MaterialFromParent' }]);
      const blockB = c.block('B', [c.reference(blockA)], [{ colorSource: 'ColorFromLayer', materialSource: 'MaterialFromParent' }]);
      c.addInstance(blockB, undefined, { color: [255, 0, 0, 255], colorSource: 'ColorFromObject', material: glass, materialSource: 'MaterialFromObject' });
    };
    const result = await readRhino3dm(await craft(build), { bakeInstances: true });
    // The box keeps its own white object colour and takes the glass transparency two levels up.
    expect(bytes255(result.meshes[0].color)).toEqual([255, 255, 255, 128]);
  });
});
