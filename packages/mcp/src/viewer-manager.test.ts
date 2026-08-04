/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ViewerManager } from './viewer-manager.js';
import { loadIfcModel } from './loader.js';
import type { LoadedModel } from './context.js';

// EntityNode is mocked so `handlePicked`'s globalId enrichment can be forced
// to throw without depending on a real malformed row. `handlePicked` invokes
// this with `new`, so the mock must be a real class (vitest warns — and, left
// as an arrow-function mockImplementation, pollutes the very console.warn spy
// under test — if a `vi.fn()` is `new`'d without one).
vi.mock('@ifc-lite/query', () => ({
  EntityNode: class ThrowingEntityNode {
    constructor() {
      throw new Error('boom: malformed entity row');
    }
  },
}));

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0$aXM2u710w8JJXA1sQ$4',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#72= IFCWALL('0$aXM2u710w8JJXA1sQ$5',$,'Wall A',$,$,#40,$,'tagA',$);
ENDSEC;
END-ISO-10303-21;
`;

describe('ViewerManager silent catches', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;
  let model: LoadedModel;
  let wallExpressId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifc-lite-viewer-manager-'));
    const filePath = join(dir, 'model.ifc');
    await writeFile(filePath, MODEL);
    model = await loadIfcModel(filePath);
    const wall = [...model.store.entityIndex.byId.entries()].find(
      ([, row]) => row.type === 'IFCWALL',
    );
    if (!wall) throw new Error('fixture wall not found in parsed store');
    wallExpressId = wall[0];
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('SSE frame parse failure', () => {
    it('warns once even across many malformed frames in the same session', () => {
      const vm = new ViewerManager(() => null);
      const handleSseFrame = vm['handleSseFrame'].bind(vm);

      for (let i = 0; i < 5; i++) {
        handleSseFrame('data: {not json');
      }

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[viewer-manager]');
    });

    it('warns again after a fresh session (open() resets the latch)', () => {
      const vm = new ViewerManager(() => null);
      const handleSseFrame = vm['handleSseFrame'].bind(vm);

      handleSseFrame('data: {not json');
      handleSseFrame('data: {still not json');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // A fresh session (as open() would start) resets the per-session latch.
      vm['sseParseWarned'] = false;

      handleSseFrame('data: {yet another bad frame');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('globalId enrichment failure', () => {
    it('warns once even across many picked events in the same session', () => {
      const vm = new ViewerManager(() => model);
      const handlePicked = vm['handlePicked'].bind(vm);

      for (let i = 0; i < 5; i++) {
        handlePicked(wallExpressId, 'IfcWall');
      }

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[viewer-manager]');
    });

    it('warns again after a fresh session (open() resets the latch)', () => {
      const vm = new ViewerManager(() => model);
      const handlePicked = vm['handlePicked'].bind(vm);

      handlePicked(wallExpressId, 'IfcWall');
      handlePicked(wallExpressId, 'IfcWall');
      expect(warnSpy).toHaveBeenCalledTimes(1);

      vm['globalIdWarned'] = false;

      handlePicked(wallExpressId, 'IfcWall');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});
