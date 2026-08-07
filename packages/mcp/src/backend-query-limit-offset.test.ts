/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `descriptor.limit` / `descriptor.offset` guards in `entities()`
 * (backend-query.ts), exercised through the public SDK path
 * `bim.query().limit(n).offset(n).toArray()`.
 *
 * No built-in MCP tool reaches this: `query_entities` (tools/query.ts)
 * schema-validates `limit`/`offset` as JSON-Schema integers before its
 * handler runs, and does its own pagination via `paginate()` in
 * tools/util.ts rather than chaining `.limit()/.offset()` on the query
 * builder. But `HeadlessLikeBackend` is exported from both `./index.js`
 * and `./browser.js` for programmatic/embedder use, and an embedder
 * driving it through `@ifc-lite/sdk`'s fluent `QueryBuilder` (exactly
 * the shape `namespaces.test.ts` in packages/sdk exercises) reaches
 * `descriptor.limit`/`descriptor.offset` directly with whatever value
 * it computed -- unguarded by any tool-schema layer. This mirrors the
 * CLI's `headless-backend.ts`, fixed for the same shape in #2298; mcp
 * has its own parallel implementation with its own tests.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIfcModel } from './loader.js';
import type { LoadedModel } from './context.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#73,#74),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
#74= IFCWALL('${guid('WALC')}',$,'Wall C',$,$,#40,$,'tagC',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let model: LoadedModel;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-limit-offset-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  model = await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' });
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function wallNames(): string[] {
  return model.bim.query().byType('IfcWall').toArray().map((e) => e.name ?? '');
}

describe('descriptor.limit / descriptor.offset — bounding controls (must pass before and after the fix)', () => {
  it('an absent limit/offset returns everything', () => {
    expect(model.bim.query().byType('IfcWall').toArray()).toHaveLength(3);
  });

  it('a valid limit still limits', () => {
    expect(model.bim.query().byType('IfcWall').limit(1).toArray()).toHaveLength(1);
  });

  it('a valid offset still skips', () => {
    const all = wallNames();
    const skipped = model.bim.query().byType('IfcWall').offset(1).toArray().map((e) => e.name);
    expect(skipped).toEqual(all.slice(1));
  });
});

describe('descriptor.limit / descriptor.offset — the defect (RED against unfixed code)', () => {
  it('NaN limit does not silently return every row', () => {
    // A caller that computed limit via e.g. `Number(userInput)` on a
    // non-numeric string gets NaN. Every comparison with NaN is false, so
    // the unfixed `descriptor.limit && descriptor.limit > 0` guard is
    // falsy and the limit is silently dropped -- the query returns all 3
    // rows instead of failing loudly. This must throw, not return 3.
    expect(() => model.bim.query().byType('IfcWall').limit(Number.NaN).toArray()).toThrow();
  });

  it('NaN offset does not silently return every row', () => {
    expect(() => model.bim.query().byType('IfcWall').offset(Number.NaN).toArray()).toThrow();
  });

  it('a negative limit does not silently return every row', () => {
    expect(() => model.bim.query().byType('IfcWall').limit(-1).toArray()).toThrow();
  });

  it('a negative offset does not silently return every row', () => {
    expect(() => model.bim.query().byType('IfcWall').offset(-1).toArray()).toThrow();
  });

  it('Infinity limit does not silently return every row', () => {
    expect(() => model.bim.query().byType('IfcWall').limit(Number.POSITIVE_INFINITY).toArray()).toThrow();
  });

  it('limit: 0 is a deliberate empty result, not "unlimited" (behaviour change, called out here and in the changeset)', () => {
    expect(model.bim.query().byType('IfcWall').limit(0).toArray()).toHaveLength(0);
  });
});
