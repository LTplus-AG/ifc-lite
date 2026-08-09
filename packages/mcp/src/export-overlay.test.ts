/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `export_ifc`, driven end to end through the real mutation tools — the sixth
 * instance in github.com/LTplus-AG/ifc-lite/issues/2012 and its round trip.
 *
 * A `global_ids` allowlist is resolved through `bim.query()`, which folds the
 * session's queued creates (#2014), and then handed to `StepExporter` as an
 * isolated-id set. Until #2012 the exporter's visible-only closure was computed
 * over the source buffer alone, so naming a created entity in the allowlist
 * still produced a file without it — and, when the allowlist named ONLY created
 * entities, an empty ref list fell through to an unfiltered export that wrote
 * the whole model to disk and reported success.
 *
 * Every assertion re-parses the written file. The point is what is on disk, not
 * what the exporter believed it wrote.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { CallToolResult } from './protocol/index.js';
import type { ToolContext } from './context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from './context.js';
import { fullScope } from './auth/scope.js';
import { loadIfcModel } from './loader.js';
import { queryTools } from './tools/query.js';
import { mutationTools } from './tools/mutate.js';
import { exportTools } from './tools/export.js';
import { discoveryTools } from './tools/discovery.js';

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
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;
let counter = 0;

const ALL_TOOLS = [...queryTools, ...mutationTools, ...exportTools, ...discoveryTools];

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const result = await tool(name).handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result;
}

async function structured<T>(name: string, input: Record<string, unknown>): Promise<T> {
  return (await call(name, input)).structuredContent as unknown as T;
}

/** One fresh session per test — the overlay lives for the life of the model. */
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

/** Write the export and parse it back off disk. */
async function exportAndReparse(input: Record<string, unknown>): Promise<{
  store: IfcDataStore;
  globalIds: string[];
  typeOf(expressId: number): string | null;
}> {
  const filePath = join(tmp, `out-${counter++}.ifc`);
  await call('export_ifc', { file_path: filePath, ...input });
  const bytes = new Uint8Array(await readFile(filePath));
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const extractor = new EntityExtractor(store.source!);
  const globalIds: string[] = [];
  for (const [, ref] of store.entityIndex.byId) {
    const first = extractor.extractEntity(ref)?.attributes?.[0];
    if (typeof first === 'string' && first.length === 22) globalIds.push(first);
  }
  return {
    store,
    globalIds,
    typeOf: (expressId) => store.entityIndex.byId.get(expressId)?.type ?? null,
  };
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-export-overlay-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('export_ifc global_ids reaches entities this session created (#2012)', () => {
  it('exports a created entity named alongside a parsed one', async () => {
    await session();
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [guid('NEWW'), null, 'Created Wall', null, null, '#40', null, null, null],
    });

    const out = await exportAndReparse({ global_ids: [guid('NEWW'), guid('WALA')] });

    expect(out.globalIds).toContain(guid('NEWW'));
    expect(out.globalIds).toContain(guid('WALA'));
    expect(out.typeOf(created.expressId)).toBe('IFCWALL');
    // Wall B was not on the allowlist, so the filter really ran.
    expect(out.globalIds).not.toContain(guid('WALB'));
  }, 30_000);

  it('exports an allowlist that names ONLY created entities', async () => {
    await session();
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [guid('SOLO'), null, 'Solo Wall', null, null, '#40', null, null, null],
    });

    const out = await exportAndReparse({ global_ids: [guid('SOLO')] });

    expect(out.typeOf(created.expressId)).toBe('IFCWALL');
    expect(out.globalIds).toContain(guid('SOLO'));
    // The whole-model fall-through is what made this case dangerous: it used to
    // write every wall in the file and call it a one-entity export.
    expect(out.globalIds).not.toContain(guid('WALA'));
    expect(out.globalIds).not.toContain(guid('WALB'));
  }, 30_000);

  it('refuses rather than exporting the whole model when nothing matches', async () => {
    await session();
    const filePath = join(tmp, 'never-written.ifc');
    await expect(
      tool('export_ifc').handler({ file_path: filePath, global_ids: [guid('NOPE')] }, ctx),
    ).rejects.toThrow(/nothing to export/);
    await expect(readFile(filePath)).rejects.toThrow();
  }, 30_000);

  it('reports the ids it could not match, and still exports the ones it could', async () => {
    await session();
    const payload = await structured<{ exportedCount: number; unmatchedGlobalIds?: string[] }>(
      'export_ifc',
      { file_path: join(tmp, 'partial.ifc'), global_ids: [guid('WALA'), guid('NOPE')] },
    );

    expect(payload.exportedCount).toBe(1);
    expect(payload.unmatchedGlobalIds).toEqual([guid('NOPE')]);
  }, 30_000);
});

describe('a create/edit/delete session round-trips through export_ifc (#2012)', () => {
  it('saves what the session did, not what the file said', async () => {
    await session();
    const kept = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [guid('KEPT'), null, 'placeholder', null, null, '#40', null, null, null],
    });
    await call('entity_set_attribute', {
      express_id: kept.expressId,
      attribute: 'Name',
      value: 'Renamed After Create',
    });
    const doomed = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [guid('GONE'), null, 'Doomed', null, null, '#40', null, null, null],
    });
    await call('entity_delete', { express_id: doomed.expressId });
    await call('entity_delete', { global_id: guid('WALB') });

    const out = await exportAndReparse({});

    // Created, then edited: the file carries the edit.
    expect(out.typeOf(kept.expressId)).toBe('IFCWALL');
    const keptName = new EntityExtractor(out.store.source!).extractEntity(
      out.store.entityIndex.byId.get(kept.expressId)!,
    )?.attributes?.[2];
    expect(keptName).toBe('Renamed After Create');
    // Created, then deleted: nothing at all.
    expect(out.typeOf(doomed.expressId)).toBeNull();
    expect(out.globalIds).not.toContain(guid('GONE'));
    // Parsed, then deleted.
    expect(out.globalIds).not.toContain(guid('WALB'));
    expect(out.globalIds).toContain(guid('WALA'));
  }, 30_000);

  it('counts a created-then-deleted entity exactly once', async () => {
    await session();
    const doomed = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [guid('TEMP'), null, 'Temp', null, null, '#40', null, null, null],
    });
    const before = await structured<{ entityCount: number }>('model_info', {});
    await call('entity_delete', { express_id: doomed.expressId });
    const after = await structured<{ entityCount: number }>('model_info', {});

    // Deleting the entity that was just created must undo exactly its own
    // contribution. Subtracting a created-then-deleted tombstone as if it named
    // a store entity double-counts it and reports one entity too few.
    expect(after.entityCount).toBe(before.entityCount - 1);
  }, 30_000);
});
