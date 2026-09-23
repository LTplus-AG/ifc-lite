/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids_validate` after `entity_delete` / `entity_create` in the same session
 * validates the effective model (#5184): the deleted wall is not validated,
 * and the created wall is, with its authored Name.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { mutationTools } from './mutate.js';
import { validationTools } from './validation.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj00000000000000000',$,'Proj',$,$,$,$,$,$);
#72= IFCWALL('0WalA00000000000000000',$,'Wall A',$,$,$,$,'tagA',$);
#73= IFCWALL('0WalB00000000000000000',$,$,$,$,$,$,'tagB',$);
ENDSEC;
END-ISO-10303-21;
`;

const WALLS_NAMED = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Walls</title></info>
  <specifications>
    <specification name="Walls must be named" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

interface IdsSummary {
  summary: { totalEntities: number; passedEntities: number; failedEntities: number };
}

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-ids-overlay-'));
  await writeFile(join(tmp, 'walls.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function session(): Promise<ToolContext> {
  const ctx: ToolContext = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'walls.ifc'), { modelId: 'm' }));
  return ctx;
}

function call(ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const tool = [...mutationTools, ...validationTools].find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool.handler(input, ctx);
}

async function validate(ctx: ToolContext): Promise<IdsSummary['summary']> {
  const out = await call(ctx, 'ids_validate', { ids_xml: WALLS_NAMED });
  return (out.structuredContent as unknown as IdsSummary).summary;
}

describe('ids_validate over a live overlay (#5184)', () => {
  it('control: both source walls are validated and the unnamed one fails', async () => {
    const summary = await validate(await session());
    expect(summary).toMatchObject({ totalEntities: 2, passedEntities: 1, failedEntities: 1 });
  });

  it('a deleted wall is not validated, and a created named wall is', async () => {
    const ctx = await session();
    await call(ctx, 'entity_delete', { express_id: 73 });
    await call(ctx, 'entity_create', {
      type: 'IfcWall',
      attributes: ['2WalC00000000000000000', null, 'Wall C', null, null, null, null, null, null],
    });

    const summary = await validate(ctx);
    expect(summary).toMatchObject({ totalEntities: 2, passedEntities: 2, failedEntities: 0 });
  });
});
