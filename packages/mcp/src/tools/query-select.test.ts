/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query_entities`'s `selector` param (#4094) — the MCP half of the
 * selector adapter. The handler is wired as `m.bim.query().byType(...)
 * .select(selector)`, reusing the SDK's `QueryBuilder.select()` (itself a
 * thin wrapper over `@ifc-lite/query`'s shared `selectorToQueryDescriptor`)
 * rather than re-parsing selector text in this package. These tests prove
 * the param actually reaches that shared translator end to end — an
 * accepted selector narrows the real result set, and a rejected one comes
 * back as a clean `isError` result naming the construct (not a thrown
 * exception that would crash the server's tool-call dispatch, and not a
 * silently empty or partial result) — not just that `QueryBuilder.select()`
 * or the translator work in isolation (covered in `packages/sdk` and
 * `packages/query` respectively).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { queryTools } from './query-tools.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall A: Pset_WallCommon.FireRating = '2HR' and Qto_WallBaseQuantities.NetVolume = 12.5.
// Wall B: Pset_WallCommon.FireRating = '1HR', no quantity set.
// Door C: not a wall at all.
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
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72,#90,#95),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#81= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#80= IFCPROPERTYSET('${guid('PST1')}',$,'Pset_WallCommon',$,(#81));
#82= IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#72),#80);
#110= IFCQUANTITYVOLUME('NetVolume',$,$,12.5,$);
#111= IFCELEMENTQUANTITY('${guid('QTO1')}',$,'Qto_WallBaseQuantities',$,$,(#110));
#112= IFCRELDEFINESBYPROPERTIES('${guid('RDPQ')}',$,$,$,(#72),#111);
#90= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
#91= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);
#92= IFCPROPERTYSET('${guid('PST2')}',$,'Pset_WallCommon',$,(#91));
#93= IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#90),#92);
#95= IFCDOOR('${guid('DOOR')}',$,'Door C',$,$,#40,$,'tagC',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const tool = queryTools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler(input, ctx);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-query-select-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' }));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('query_entities selector param', () => {
  it('narrows the real result set through the shared translator (class + exact-name Pset comparison)', async () => {
    const result = await call('query_entities', {
      selector: 'IfcWall, Pset_WallCommon.FireRating=2HR',
      fields: ['name'],
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { count: number; entities: Array<{ name: string }> };
    expect(content.count).toBe(1);
    expect(content.entities[0].name).toBe('Wall A');
  });

  it('a Qto_ comparison in selector also narrows correctly (quantity-set fallback)', async () => {
    const result = await call('query_entities', {
      selector: 'IfcWall, Qto_WallBaseQuantities.NetVolume>1',
      fields: ['name'],
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { count: number; entities: Array<{ name: string }> };
    expect(content.count).toBe(1);
    expect(content.entities[0].name).toBe('Wall A');
  });

  it('ANDs with type: selector narrows further within the type-selected set', async () => {
    const result = await call('query_entities', {
      type: 'IfcWall',
      selector: 'Pset_WallCommon.FireRating=1HR',
      fields: ['name'],
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { count: number; entities: Array<{ name: string }> };
    expect(content.count).toBe(1);
    expect(content.entities[0].name).toBe('Wall B');
  });

  it('unions a selector class with type, matching repeated byType semantics', async () => {
    const result = await call('query_entities', {
      type: 'IfcDoor',
      selector: 'IfcWall',
      fields: ['type'],
    });
    expect(result.isError).toBeUndefined();
    const content = result.structuredContent as { count: number; entities: Array<{ type: string }> };
    expect(content.count).toBe(3);
    expect(new Set(content.entities.map((entity) => entity.type))).toEqual(new Set(['IfcWall', 'IfcDoor']));
  });

  // `SelectorUnsupportedError` propagates as a thrown Error out of the raw
  // handler, the same shape `entity_create`'s abstract-type rejection takes
  // (`overlay.test.ts`) — the server's tool-call dispatch (`server.ts`,
  // `try { … } catch (err) { … return toolError(...) }`) sits above this,
  // turning any thrown Error into a clean `isError: true` CallToolResult
  // carrying `.message` as both `content[0].text` and `structuredContent.
  // message` (`packages/mcp/src/errors.ts`'s `toolError`). Not exercised
  // here — testing the raw handler directly, per that same precedent test's
  // own comment — but confirmed by reading `server.ts`'s dispatch, not
  // assumed.
  it('rejects rather than silently running an empty/partial query when the selector uses an unsupported construct', async () => {
    await expect(async () =>
      call('query_entities', { selector: 'IfcWall, parent=Building' }),
    ).rejects.toThrow(/parent=Building/);
  });
});
