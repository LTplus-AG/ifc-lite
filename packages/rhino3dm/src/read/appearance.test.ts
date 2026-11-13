/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';
import { readRhino3dm } from '../index.js';
import { craft, drawnTriangles, translation, type AttributeSpec, type Craft } from '../../test-support/craft.js';

/**
 * How a block member's "from parent" colour and material resolve (#9987). The expected values come
 * from `ON_3dmObjectAttributes::ApplyParentalControl` in openNURBS 8.x, the function Rhino itself
 * uses, run over all 144 combinations of a member's and an instance's two sources.
 *
 * The resolution table, the citation for each row and the four known divergences are in
 * `docs/architecture/rhino-3dm-import.md`, under "Block members and from parent".
 */

const unit = (c: Craft) => c.box([0, 0, 0], [1, 1, 1]);
/** Colour channels back as the 0-255 integers the file stores, so a row reads like the file. */
const bytes255 = (color: readonly number[]) => color.map(v => Math.round(v * 255));
/** Where the instance sits, far enough out that a member's own x stays legible in its origin. */
const PLACED_AT = 100;

describe('a block member resolved against the instance placing it', () => {
  /**
   * One row of the table. `material: 'own'` gives the member the opaque `Solid` material; the rest
   * take their material from their layer, which names none, or from the instance.
   */
  interface Row {
    colorSource: NonNullable<AttributeSpec['colorSource']>;
    materialSource: NonNullable<AttributeSpec['materialSource']>;
    material?: 'own';
    /** What the member is drawn with, as the file's 0-255 channels. */
    drawn: number[];
    why: string;
    /** Where the member's mesh ends up: in the shared definition, open for the instance, or baked. */
    where: 'definition' | 'instance' | 'baked';
  }

  // The instance is red and opaque, and names a blue material at half transparency, so its own
  // resolved colour is red at alpha 128 while its material's diffuse colour is blue. Every row
  // whose answer differs between those two settles something.
  const INSTANCE_COLOR = [255, 0, 0, 128];

  const ROWS: Row[] = [
    { colorSource: 'ColorFromObject', materialSource: 'MaterialFromLayer', drawn: [255, 255, 255, 255], where: 'definition',
      why: 'its own object colour, its layer naming no material' },
    { colorSource: 'ColorFromObject', materialSource: 'MaterialFromParent', drawn: [255, 255, 255, 128], where: 'baked',
      why: "its own object colour at the instance material's transparency" },
    { colorSource: 'ColorFromLayer', materialSource: 'MaterialFromLayer', drawn: [0, 128, 0, 255], where: 'definition',
      why: "its OWN layer's colour, never the instance's layer" },
    { colorSource: 'ColorFromLayer', materialSource: 'MaterialFromParent', drawn: [0, 128, 0, 128], where: 'baked',
      why: "its own layer's colour at the instance material's transparency" },
    { colorSource: 'ColorFromMaterial', materialSource: 'MaterialFromObject', material: 'own', drawn: [255, 255, 0, 255], where: 'definition',
      why: 'the diffuse colour of the material it names' },
    { colorSource: 'ColorFromMaterial', materialSource: 'MaterialFromParent', drawn: [0, 0, 255, 128], where: 'baked',
      why: "the INSTANCE MATERIAL's diffuse colour, not the instance's object colour" },
    // The reader's answer, not openNURBS's: this is the fourth known divergence in the spec.
    // openNURBS copies the instance's stored colour, which carries no material transparency, and
    // then fades the member by its own material, which here is none, so Rhino draws it opaque.
    { colorSource: 'ColorFromParent', materialSource: 'MaterialFromLayer', drawn: INSTANCE_COLOR, where: 'instance',
      why: "the instance's resolved colour, alpha included" },
    { colorSource: 'ColorFromParent', materialSource: 'MaterialFromParent', drawn: INSTANCE_COLOR, where: 'instance',
      why: "the instance's resolved colour; both inherited, so the two agree exactly" },
  ];

  /** The rows as members of one block, each a box at x = its row index. */
  function sources(c: Craft) {
    const memberLayer = c.layer('Member', { color: [0, 128, 0, 255] });
    const instanceLayer = c.layer('Instance', { color: [255, 255, 0, 255] });
    const glass = c.material('Glass', [0, 0, 255, 255], 0.5);
    const solid = c.material('Solid', [255, 255, 0, 255]);
    const block = c.block('Sources', ROWS.map((_, i) => c.box([i, 0, 0], [i + 1, 1, 1])), ROWS.map((row): AttributeSpec => ({
      layer: memberLayer, color: [255, 255, 255, 255], colorSource: row.colorSource,
      materialSource: row.materialSource, ...(row.material === 'own' ? { material: solid } : {}),
    })));
    c.addInstance(block, translation(PLACED_AT, 0, 0), {
      layer: instanceLayer, color: [255, 0, 0, 255], colorSource: 'ColorFromObject',
      material: glass, materialSource: 'MaterialFromObject',
    });
  }

  // One build and one read for the whole table: every row asks the same file a different question.
  const file = craft(sources);
  const bakedRead = file.then(bytes => readRhino3dm(bytes, { bakeInstances: true }));

  test.each(ROWS.map((row, index): [string, number, Row] => [`${row.colorSource} + ${row.materialSource} draws ${row.why}`, index, row]))(
    '%s', async (_name, index, row) => {
      // Baked, so every row is a mesh of its own, found by the x its box was built at.
      const drawn = (await bakedRead).meshes.find(m => Math.round(m.origin[0]) === PLACED_AT + index);
      expect(drawn && bytes255(drawn.color)).toEqual(row.drawn);
    });

  test('each row lands where its colour can be drawn from, and both modes draw the same', async () => {
    const instanced = await readRhino3dm(await file), baked = await bakedRead;
    // Both read in member order, so each list below follows ROWS.
    const rows = (kind: Row['where']) => ROWS.flatMap((row, index) => row.where === kind ? [[index, row]] as const : []);
    // A definition mesh holds one colour or none, so a row whose colour the instance's material
    // decides cannot live there and is baked per placement instead.
    expect(instanced.definitions[0].meshes.map(m => m.color && bytes255(m.color))).toEqual(
      ROWS.filter(row => row.where !== 'baked').map(row => row.where === 'instance' ? null : row.drawn));
    expect(instanced.meshes.map(m => [Math.round(m.origin[0]) - PLACED_AT, bytes255(m.color)]))
      .toEqual(rows('baked').map(([index, row]) => [index, row.drawn]));
    expect(instanced.instances.map(i => bytes255(i.color))).toEqual([INSTANCE_COLOR]);
    // Every box is twelve triangles, counted once however the two paths split them.
    const triangles = ROWS.length * 12;
    expect([baked.meshes.length, drawnTriangles(instanced), drawnTriangles(baked)]).toEqual([ROWS.length, triangles, triangles]);
  });
});

describe('a member that inherits its material only needs baking when something can fade it', () => {
  // Such a member does not read the inherited diffuse colour, so only a transparent material can
  // change what it is drawn with. Baking them all per placement returned 5,000 mesh records and
  // 375 MB where one shared definition holds 0.08 MB, every record the same colour [ran].

  /**
   * One `MaterialFromParent` member, placed once per entry in `instances`, each instance naming a
   * material of that transparency. `stored` adds a material the file keeps and nothing names.
   */
  const panes = (instances: number[], stored?: number) => (c: Craft) => {
    const spec: AttributeSpec = { color: [255, 255, 255, 255], colorSource: 'ColorFromObject', materialSource: 'MaterialFromParent' };
    const block = c.block('Pane', [unit(c)], [spec]);
    instances.forEach((transparency, i) => c.addInstance(block, translation(i * 3, 0, 0), {
      color: [255, 0, 0, 255], material: c.material(`Paint ${i}`, [0, 0, 255, 255], transparency), materialSource: 'MaterialFromObject',
    }));
    if (stored !== undefined) c.material('Leftover glass', [0, 0, 255, 255], stored);
  };

  test.each([
    ['two instances naming opaque materials', panes([0, 0])],
    // Rhino keeps materials no object or layer names. Measuring the gate over the material table
    // instead of over what the instances resolve to let one of those bake a whole file.
    ['an opaque pair beside a transparent material the file only stores', panes([0, 0], 0.5)],
  ])('%s: one shared definition, nothing baked', async (_name, build) => {
    const result = await readRhino3dm(await craft(build));
    expect(result.definitions.map(d => d.meshes.map(m => m.color && bytes255(m.color)))).toEqual([[[255, 255, 255, 255]]]);
    expect(result.instances.map(i => i.definition)).toEqual([0, 0]);
    expect(result.meshes).toEqual([]);
  });

  test("a transparent material an instance does name bakes the member, at that instance's alpha", async () => {
    const result = await readRhino3dm(await craft(panes([0.5])));
    expect([result.definitions, result.instances]).toEqual([[], []]);
    expect(result.meshes.map(m => bytes255(m.color))).toEqual([[255, 255, 255, 128]]);
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
   * The nested-block example from the Rhino 8 object-properties help page: a box whose display
   * colour is By Parent sits in Block A, which sits in Block B. Run through openNURBS, the box
   * ends up `ColorFromObject` with Block A's layer colour when A is By Layer, and with Block B's
   * object colour when A is By Parent, which is what the help page says.
   */
  const inherit = (aByParent: boolean) => (c: Craft) => {
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
    const result = await readRhino3dm(await craft(inherit(false)), { bakeInstances: true });
    expect(bytes255(result.meshes[0].color)).toEqual([255, 255, 0, 255]);
  });

  test("Block A by parent too passes the grandparent's colour down to the box", async () => {
    const result = await readRhino3dm(await craft(inherit(true)), { bakeInstances: true });
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
