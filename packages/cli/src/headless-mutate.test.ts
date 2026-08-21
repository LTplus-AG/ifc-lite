/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.mutate.*` through the headless CLI context, asserted on the EXPORTED
 * STEP rather than on the overlay.
 *
 * The bug these cover did not throw and did not lose a return value: the
 * adapter answered every call with a no-op, so a script reported the edits it
 * had "made" and `bim.export.ifc` handed back the input unchanged. Reading the
 * mutation view back would have passed just as happily against the broken
 * adapter, so every assertion here goes through the export.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHeadlessContext } from './loader.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('WALL00000000000000000X',$,'Original Name',$,$,$,$,'tag',$);
#100= IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('W-01'),$);
#101= IFCPROPERTYSINGLEVALUE('Sibling',$,IFCLABEL('keep me'),$);
#102= IFCPROPERTYSET('PSET00000000000000000X',$,'Pset_WallCommon',$,(#100,#101));
#103= IFCRELDEFINESBYPROPERTIES('RELP00000000000000000X',$,$,$,(#70),#102);
ENDSEC;
END-ISO-10303-21;
`;

async function loadModel() {
  const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-headless-mutate-'));
  const path = join(dir, 'model.ifc');
  await writeFile(path, MODEL, 'utf-8');
  const { bim } = await createHeadlessContext(path);
  const wall = bim.query().byType('IfcWall').first();
  if (!wall) throw new Error('fixture has no IfcWall');
  return { bim, wall };
}

const exportStep = (bim: Awaited<ReturnType<typeof loadModel>>['bim']): string => {
  const content = bim.export.ifc([], { schema: 'IFC4' });
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
};

describe('bim.mutate through the headless context', () => {
  it('persists setAttribute into the exported STEP', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.setAttribute(wall.ref, 'Name', 'Renamed Wall');

    const step = exportStep(bim);
    expect(step).toContain("'Renamed Wall'");
    expect(step).not.toContain("'Original Name'");
  });

  it('leaves the export untouched when nothing was mutated', async () => {
    // Guards the assertion above: it has to be the mutation that changes the
    // output, not the re-export.
    const { bim } = await loadModel();
    expect(exportStep(bim)).toContain("'Original Name'");
  });

  it('persists a new property set and keeps the siblings of an edited one', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'FireRating', 'EI 60');
    bim.mutate.setProperty(wall.ref, 'Pset_WallCommon', 'Reference', 'Generic');

    const step = exportStep(bim);
    expect(step).toContain("'Pset_FireRating'");
    expect(step).toContain("IFCLABEL('EI 60')");
    expect(step).toContain("'Generic'");
    expect(step).not.toContain("'W-01'");
    // The overlay re-emits the whole set, so a sibling that was never touched
    // has to survive the rewrite.
    expect(step).toContain("'keep me'");
  });

  it('writes a boolean as IFCBOOLEAN and an integer as IFCINTEGER, not as labels', async () => {
    // MutablePropertyView.setProperty defaults to PropertyValueType.String, so
    // an adapter that forwards the raw value writes IFCLABEL('true') here.
    const { bim, wall } = await loadModel();
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'FireCompartmentation', true);
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'Storeys', 3);
    bim.mutate.setProperty(wall.ref, 'Pset_FireRating', 'Ratio', 1.5);

    const step = exportStep(bim);
    expect(step).toContain('IFCBOOLEAN(.T.)');
    expect(step).toContain('IFCINTEGER(3)');
    expect(step).toContain('IFCREAL(1.5)');
    expect(step).not.toContain("IFCLABEL('true')");
  });

  it('persists deleteProperty', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.deleteProperty(wall.ref, 'Pset_WallCommon', 'Reference');

    const step = exportStep(bim);
    expect(step).not.toContain("'W-01'");
    expect(step).toContain("'keep me'");
  });

  it('accepts a batch and reports that there is nothing to undo', async () => {
    const { bim, wall } = await loadModel();
    bim.mutate.batch('rename', () => {
      bim.mutate.setAttribute(wall.ref, 'Name', 'Batched');
    });

    expect(exportStep(bim)).toContain("'Batched'");
    // No mutation history in a headless session; false is the honest answer.
    expect(bim.mutate.undo('default')).toBe(false);
    expect(bim.mutate.redo('default')).toBe(false);
  });
});
