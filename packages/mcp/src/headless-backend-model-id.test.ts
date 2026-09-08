/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One backend, one answer to "is this a model id I hold".
 *
 * The MCP backend used to hold two rules for one question: `bim.mutate.*` was
 * gated on `modelId || modelName`, while the schedule assert in the same class
 * admitted `modelId` alone, and no other MCP site accepts a file basename at
 * all. So the basename was writable and unreadable in the same session, and
 * which surface a caller reached first decided whether their id worked (#3764).
 *
 * The fixture is the case that separates them: a file whose name is nothing
 * like its model id.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';
import type { HeadlessLikeBackend } from './headless-backend.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

/** The file is `building.ifc`; the model is registered as `m`. */
const BASENAME = 'building.ifc';
const MODEL_ID = 'm';

let tmp: string;
let backend: HeadlessLikeBackend;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-model-id-'));
  await writeFile(join(tmp, BASENAME), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function load(): Promise<HeadlessLikeBackend> {
  const loaded = await loadIfcModel(join(tmp, BASENAME), { modelId: MODEL_ID });
  return loaded.backend;
}

describe('HeadlessLikeBackend model-id acceptance', () => {
  beforeAll(async () => {
    backend = await load();
  });

  it('gives the write guard and the schedule assert the same answer for the file basename', () => {
    // The point of the test is the AGREEMENT, so both are asserted the same
    // way. Whichever answer the backend settles on, a caller must not be able
    // to find one surface that says yes and another that says no.
    const write = (): void => backend.mutate.setAttribute(
      { modelId: BASENAME, expressId: 70 }, 'Name', 'Renamed',
    );
    const read = (): unknown => backend.schedule.data(BASENAME);

    expect(backend.acceptsModelId(BASENAME)).toBe(false);
    expect(write).toThrow(/unknown model 'building\.ifc'/);
    expect(read).toThrow(/Unknown modelId 'building\.ifc'/);
  });

  it('accepts the model id itself on both surfaces', () => {
    // Guards the pair above: they have to disagree with the basename, not with
    // every id.
    expect(backend.acceptsModelId(MODEL_ID)).toBe(true);
    expect(() => backend.mutate.setAttribute({ modelId: MODEL_ID, expressId: 70 }, 'Name', 'Renamed')).not.toThrow();
    expect(() => backend.schedule.data(MODEL_ID)).not.toThrow();
  });

  it('mints store refs under the same rule', () => {
    // The third surface that has to agree: a ref created under an id the write
    // guard refuses is a ref its own creator should never have handed out.
    expect(() => backend.store.addEntity(BASENAME, { type: 'IfcWall', attributes: [] }))
      .toThrow(/Unknown modelId 'building\.ifc'/);
    const ref = backend.store.addEntity(MODEL_ID, { type: 'IfcWall', attributes: [] });
    expect(() => backend.mutate.setProperty(ref, 'Pset_X', 'Y', 'v')).not.toThrow();
  });
});
