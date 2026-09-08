/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared fixture plumbing for the headless-backend tests.
 *
 * The three suites all want the same thing: an inline IFC model on disk, a real
 * headless context over it, and the exported STEP back as text. Written once
 * here so a change to `createHeadlessContext` or to the header the parser
 * accepts is one edit rather than three. Mirrors `diff-test-helpers.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadlessContext } from './loader.js';

/** Project, context, units — the prologue every fixture needs and none tests. */
export const IFC_PREAMBLE = `#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`;

/** Wrap DATA-section lines in a minimal valid STEP file. */
export function ifcFile(dataSection: string, schema = 'IFC4'): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2024',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
${IFC_PREAMBLE}
${dataSection}
ENDSEC;
END-ISO-10303-21;
`;
}

/**
 * Write a model to a temp dir and open a real headless context over it.
 *
 * The directory is removed once the context is open: `loadIfcFile` reads the
 * whole file into `store.source` before returning, so nothing reads it back off
 * disk afterwards. Removed on the failure path too, so a broken fixture does
 * not leave one behind per test.
 */
export async function loadInlineModel(source: string, label = 'headless') {
  const dir = await mkdtemp(join(tmpdir(), `ifc-lite-${label}-`));
  try {
    const path = join(dir, 'model.ifc');
    await writeFile(path, source, 'utf-8');
    return (await createHeadlessContext(path)).bim;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type HeadlessBim = Awaited<ReturnType<typeof loadInlineModel>>;

/**
 * Export and decode.
 *
 * Every mutation assertion in these suites goes through the export rather than
 * reading the overlay back: the overlay answers correctly even when nothing
 * reaches the file, which is exactly the bug these suites were written for.
 */
export function exportStep(bim: HeadlessBim, schema: 'IFC2X3' | 'IFC4' | 'IFC4X3' = 'IFC4'): string {
  const content = bim.export.ifc([], { schema });
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

/** The `Item` ref of every `IfcStyledItem` in an exported file. */
export function styledTargets(step: string): number[] {
  return [...step.matchAll(/IFCSTYLEDITEM\(#(\d+),/g)].map(m => Number(m[1]));
}
