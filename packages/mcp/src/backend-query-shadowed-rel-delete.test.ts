/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Nothing in EXPRESS forbids two `IfcRelContainedInSpatialStructure`
 * instances from naming the same (storey, wall) pair (#3760).
 * `RelationshipGraphBuilder.addEdge` collapses the repeat into one edge,
 * keeping the first `IfcRel*`'s express id as `relationshipId` and the rest
 * in `shadowedRelationshipIds`. The MCP backend's `related()`
 * (`packages/mcp/src/backend-query.ts`) must treat the connection as alive
 * as long as ANY of those ids still exists — the fix for the Codex P2 on
 * #3782 ("Preserve independently deletable relationship records"): deleting
 * only the surviving `IfcRel*` used to make the storey/wall connection
 * disappear even though a second, redundant `IfcRel*` still legally
 * related them.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from './context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from './context.js';
import { fullScope } from './auth/scope.js';
import { loadIfcModel } from './loader.js';
import { mutationTools } from './tools/mutate.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Storey #41 contains Wall #72 via TWO separate IfcRelContainedInSpatialStructure
// records (#45 and #46) — a redundant export, or two tools each writing their
// own containment record for the same pair.
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
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELA')}',$,$,$,(#72),#41);
#46= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELB')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

function tool(name: string) {
  const found = mutationTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function call(name: string, input: Record<string, unknown>) {
  const result = await tool(name).handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result;
}

async function session(): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' }));
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-shadowed-rel-delete-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('MCP backend related() with a duplicated IfcRel (#3782)', () => {
  it('confirms the file itself declares the same containment twice', async () => {
    await session();
    const model = ctx.registry.get('m');
    if (!model) throw new Error('model not loaded');
    const related = model.bim.related({ modelId: 'm', expressId: 41 }, 'IfcRelContainedInSpatialStructure', 'forward');
    // The graph dedupes the edge, so the wall shows up once, not twice.
    expect(related).toHaveLength(1);
  });

  it('keeps the connection when the SURVIVING IfcRel is deleted but the shadowed sibling is not', async () => {
    await session();
    // #45 is the first-declared IfcRel — the one the graph keeps as
    // `relationshipId`. Deleting it must NOT remove the connection: #46
    // still legally relates the same pair.
    await call('entity_delete', { express_id: 45 });
    const model = ctx.registry.get('m');
    if (!model) throw new Error('model not loaded');
    const related = model.bim.related({ modelId: 'm', expressId: 41 }, 'IfcRelContainedInSpatialStructure', 'forward');
    expect(related.some((r) => r.ref.expressId === 72)).toBe(true);
  });

  it('removes the connection once every collapsed IfcRel is deleted', async () => {
    await session();
    await call('entity_delete', { express_id: 45 });
    await call('entity_delete', { express_id: 46 });
    const model = ctx.registry.get('m');
    if (!model) throw new Error('model not loaded');
    const related = model.bim.related({ modelId: 'm', expressId: 41 }, 'IfcRelContainedInSpatialStructure', 'forward');
    expect(related.some((r) => r.ref.expressId === 72)).toBe(false);
  });
});
