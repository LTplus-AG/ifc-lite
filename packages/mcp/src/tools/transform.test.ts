/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model transform tools (merge, convert, extract, anonymize, simplify, LOD).
 * Each result is checked by reading the written file back, not by trusting the
 * tool's own counts. Simplify and LOD run the real wasm mesher on the
 * committed `hello-wall.ifc` sample.
 */

import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { buildDefaultToolRegistry } from './index.js';
import { validateInput } from '../validate.js';
import { toolError } from '../errors.js';
import { CASE_INSENSITIVE_FS } from './transform-schema.js';
import type { CallToolResult } from '../protocol/index.js';

const HELLO_WALL = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

const model = (tag: string, storey: string, extra = ''): string => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('Acme-Tower-${tag}.ifc','2026',('Jane Architect'),('Acme Corp'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000000000000000000PR${tag}',$,'Acme Tower ${tag}',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('0000000000000000000ST${tag}',$,'${storey}',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCRELAGGREGATES('0000000000000000000AG${tag}',$,$,$,#1,(#41));
#50= IFCLOCALPLACEMENT(#40,#21);
#72= IFCWALL('000000000000000000WA1${tag}',$,'Wall A ${tag}',$,$,#50,$,'tagA',$);
#73= IFCWALL('000000000000000000WA2${tag}',$,'Wall B ${tag}',$,$,#50,$,'tagB',$);
#74= IFCSLAB('000000000000000000SL1${tag}',$,'Slab ${tag}',$,$,#50,$,$,$);
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC${tag}',$,$,$,(#72,#73,#74),#41);
${extra}ENDSEC;
END-ISO-10303-21;
`;

const registry = buildDefaultToolRegistry();
const tool = (name: string) => {
  const t = registry.get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};
const call = async (name: string, input: Record<string, unknown>) =>
  (await tool(name).handler(input, ctx)) as CallToolResult & { structuredContent: Record<string, unknown> };

let tmp: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-transform-')));
  await writeFile(join(tmp, 'a.ifc'), model('A', 'Level 1'), 'utf-8');
  await writeFile(join(tmp, 'b.ifc'), model('B', 'Level 1'), 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp, HELLO_WALL] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'a.ifc'), { modelId: 'a' }));
});

const TRANSFORMS = ['model_merge', 'model_convert', 'model_extract', 'model_anonymize', 'model_simplify', 'model_lod'];

/** A success result validates against the tool's outputSchema and names the file it wrote. */
function expectMatchesOutputSchema(name: string, structured: Record<string, unknown>): void {
  expect(validateInput(tool(name).outputSchema!, structured)).toMatchObject({ valid: true, errors: [] });
  expect(structured).toHaveProperty('filePath');
  expect(structured).toHaveProperty('bytes');
}

describe('transform tool metadata', () => {
  it.each(TRANSFORMS)('%s has a title, write annotations, an outputSchema and export scope', (name) => {
    const t = tool(name);
    expect(t.title).toBeTruthy();
    expect(t.scope).toBe('export');
    // destructive: each one replaces an existing file at file_path.
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(t.outputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    // An error result's structuredContent must validate too, for clients that check it.
    const err = toolError({ code: 'INVALID_INPUT', message: 'x', hint: 'y' });
    expect(validateInput(t.outputSchema!, err.structuredContent)).toMatchObject({ valid: true, errors: [] });
    expect(t.inputSchema.required).toContain('file_path');
    for (const [key, prop] of Object.entries(t.inputSchema.properties ?? {})) {
      expect((prop as { description?: string }).description, `${name}.${key}`).toBeTruthy();
    }
  });
});

describe('IFC5 sources', () => {
  it.each(TRANSFORMS)('%s refuses an IFC5 (IFCX) model by name instead of reading it as STEP', async (name) => {
    const m = ctx.registry.get('a')!;
    (m.store as { schemaVersion: string }).schemaVersion = 'IFC5';
    const input: Record<string, unknown> = { file_path: join(tmp, 'ifc5-out.ifc'), schema: 'IFC4', level: 0, types: ['IfcWall'] };
    if (name === 'model_merge') input.model_ids = ['a', 'a2'];
    if (name === 'model_merge') ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'a2' }));
    await expect(call(name, input)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', message: expect.stringContaining('IFC5') });
  });
});

describe('model_merge', () => {
  it('writes one file holding both models, storeys unified by name', async () => {
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'b' }));
    const out = join(tmp, 'merged.ifc');
    const res = await call('model_merge', { file_path: out });
    expectMatchesOutputSchema('model_merge', res.structuredContent);
    expect(res.structuredContent.modelCount).toBe(2);

    const merged = await loadIfcModel(out, { modelId: 'm' });
    const walls = merged.bim.query().byType('IfcWall').toArray().map((e) => e.name).sort();
    expect(walls).toEqual(['Wall A A', 'Wall A B', 'Wall B A', 'Wall B B']);
    expect(merged.bim.storeys().map((s) => s.name)).toEqual(['Level 1']);
  });

  it('defaults to the models the token may access, and refuses a model listed twice', async () => {
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'b' }));
    await writeFile(join(tmp, 'h.ifc'), model('H', 'Level 1'), 'utf-8');
    ctx.registry.add(await loadIfcModel(join(tmp, 'h.ifc'), { modelId: 'hidden' }));
    ctx.scope = { ...fullScope(), modelIds: ['a', 'b'] };
    const res = await call('model_merge', { file_path: join(tmp, 'scoped.ifc') });
    expect(res.structuredContent.modelCount).toBe(2);
    const scoped = await readFile(join(tmp, 'scoped.ifc'), 'utf-8');
    expect(scoped).toContain("'Wall A B'");
    expect(scoped).not.toContain("'Wall A H'");
    await expect(call('model_merge', { model_ids: ['a', 'a'], file_path: join(tmp, 'dup.ifc') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('keeps the first model\'s schema by default and reports converting the other model', async () => {
    const x3 = join(tmp, 'b-2x3.ifc');
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'b' }));
    await call('model_convert', { model_id: 'b', schema: 'IFC2X3', file_path: x3 });
    ctx.registry.remove('a');
    ctx.registry.remove('b');
    ctx.registry.add(await loadIfcModel(x3, { modelId: 'old' }));
    ctx.registry.add(await loadIfcModel(join(tmp, 'a.ifc'), { modelId: 'a' }));
    const out = join(tmp, 'merged-2x3.ifc');
    await call('model_merge', { model_ids: ['old', 'a'], file_path: out });
    expect(await readFile(out, 'utf-8')).toContain("FILE_SCHEMA(('IFC2X3'))");
  });

  it('leaves an IFC5 model out of the default list', async () => {
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'b' }));
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'x' }));
    (ctx.registry.get('x')!.store as { schemaVersion: string }).schemaVersion = 'IFC5';
    const res = await call('model_merge', { file_path: join(tmp, 'no-ifc5.ifc') });
    expect(res.structuredContent.modelCount).toBe(2);
  });

  it('refuses fewer than two models', async () => {
    await expect(call('model_merge', { file_path: join(tmp, 'one.ifc') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a model with unsaved edits instead of merging the stale source', async () => {
    ctx.registry.add(await loadIfcModel(join(tmp, 'b.ifc'), { modelId: 'b' }));
    await call('entity_set_attribute', { model_id: 'b', express_id: 72, attribute: 'Name', value: 'Edited' });
    await expect(call('model_merge', { file_path: join(tmp, 'edited.ifc') })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

describe('model_convert', () => {
  it('downgrades to IFC2X3 with pending edits included and returns the loss report', async () => {
    await call('entity_set_attribute', { express_id: 72, attribute: 'Name', value: 'Renamed wall' });
    const out = join(tmp, 'converted.ifc');
    const res = await call('model_convert', { schema: 'IFC2X3', file_path: out });
    expectMatchesOutputSchema('model_convert', res.structuredContent);
    expect(res.structuredContent).toMatchObject({ sourceSchema: 'IFC4', targetSchema: 'IFC2X3' });

    const text = await readFile(out, 'utf-8');
    expect(text).toContain("FILE_SCHEMA(('IFC2X3'))");
    expect(text).toContain("'Renamed wall'");
    const reloaded = await loadIfcModel(out, { modelId: 'c' });
    expect(reloaded.store.schemaVersion).toBe('IFC2X3');
  });
});

describe('model_extract', () => {
  it('keeps the selected product and its context, not its siblings', async () => {
    const out = join(tmp, 'extract.ifc');
    const res = await call('model_extract', { global_ids: ['000000000000000000WA1A'], file_path: out });
    expectMatchesOutputSchema('model_extract', res.structuredContent);
    expect(res.structuredContent.seedCount).toBe(1);

    const sub = await loadIfcModel(out, { modelId: 's' });
    expect(sub.bim.query().byType('IfcWall').toArray().map((e) => e.name)).toEqual(['Wall A A']);
    expect(sub.bim.query().byType('IfcSlab').toArray()).toHaveLength(0);
    expect(sub.bim.storeys().map((s) => s.name)).toEqual(['Level 1']);
  });

  it('unions selectors: a type plus an express id', async () => {
    const out = join(tmp, 'extract-union.ifc');
    const res = await call('model_extract', { types: ['IfcSlab'], express_ids: [73], file_path: out });
    expect(res.structuredContent.seedCount).toBe(2);
    const text = await readFile(out, 'latin1');
    expect(text).toContain("'Slab A'");
    expect(text).toContain("'Wall B A'");
    expect(text).not.toContain("'Wall A A'");
  });

  it('reads an unprefixed type as Ifc-prefixed, like model_anonymize and the CLI', async () => {
    const res = await call('model_extract', { types: ['Slab'], file_path: join(tmp, 'extract-slab.ifc') });
    expect(res.structuredContent.seedCount).toBe(1);
  });

  it('refuses a type that matches nothing even when another selector matches', async () => {
    await expect(call('model_extract', { global_ids: ['000000000000000000WA1A'], types: ['IfcWal'], file_path: join(tmp, 'x.ifc') }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('IfcWal') });
  });

  it('treats blank selectors as no selection', async () => {
    await expect(call('model_extract', { global_ids: [''], storeys: [' '], file_path: join(tmp, 'x.ifc') }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Select something') });
  });

  it('fails loudly on a GlobalId the model does not have, and on a type that matches nothing', async () => {
    await expect(call('model_extract', { global_ids: ['NOPE00000000000000000X'], file_path: join(tmp, 'x.ifc') }))
      .rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
    await expect(call('model_extract', { types: ['IfcDoor'], file_path: join(tmp, 'x.ifc') }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('model_anonymize', () => {
  it('strips project-identifying names and writes a separate GUID map', async () => {
    const out = join(tmp, 'anon.ifc');
    const map = join(tmp, 'anon-guids.json');
    const res = await call('model_anonymize', { global_ids: ['000000000000000000WA1A'], file_path: out, guid_map_path: map });
    expectMatchesOutputSchema('model_anonymize', res.structuredContent);

    const text = await readFile(out, 'latin1');
    for (const secret of ['Acme', 'Jane Architect', 'Wall A A', '000000000000000000WA1A']) expect(text).not.toContain(secret);
    expect(text).toContain('IFCWALL(');
    const guidMap = JSON.parse(await readFile(map, 'utf-8')) as Record<string, string>;
    const anon = await loadIfcModel(out, { modelId: 'anon' });
    const [wall] = anon.bim.query().byType('IfcWall').toArray();
    expect(guidMap['000000000000000000WA1A']).toBe(wall.globalId);
    if (process.platform !== 'win32') expect((await stat(map)).mode & 0o777).toBe(0o600);
  });

  it('matches a storey by case-insensitive name fragment, as the CLI does', async () => {
    const res = await call('model_anonymize', { storey: 'level', file_path: join(tmp, 'anon-storey.ifc') });
    expect(res.structuredContent.seedCount).toBe(3);
  });

  it('refuses a GUID map path equal to the output path, so the map cannot replace the anonymized file', async () => {
    const out = join(tmp, 'same.ifc');
    await expect(call('model_anonymize', { global_ids: ['000000000000000000WA1A'], file_path: out, guid_map_path: out }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    if (CASE_INSENSITIVE_FS) {
      await expect(call('model_anonymize', { global_ids: ['000000000000000000WA1A'], file_path: out, guid_map_path: join(tmp, 'SAME.ifc') }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('refuses a blank storey and a name fragment that matches several storeys', async () => {
    await expect(call('model_anonymize', { storey: ' ', file_path: join(tmp, 'x.ifc') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await writeFile(join(tmp, 'two.ifc'), model('C', 'Level 10').replace('ENDSEC;\nEND', "#43= IFCBUILDINGSTOREY('0000000000000000000S2C',$,'Level 11',$,$,#40,$,$,.ELEMENT.,3.);\nENDSEC;\nEND"), 'utf-8');
    ctx.registry.remove('a');
    ctx.registry.add(await loadIfcModel(join(tmp, 'two.ifc'), { modelId: 'two' }));
    await expect(call('model_anonymize', { storey: 'level 1', file_path: join(tmp, 'x.ifc') }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Level 10, Level 11') });
  });

  it('reads an unprefixed type as Ifc-prefixed, like the CLI', async () => {
    const res = await call('model_anonymize', { types: [' Wall'], file_path: join(tmp, 'anon-type.ifc') });
    expect(res.structuredContent.seedCount).toBe(2);
  });

  it('reads a null guid_map_path as absent', async () => {
    const res = await call('model_anonymize', { global_ids: ['000000000000000000WA1A'], file_path: join(tmp, 'anon-null.ifc'), guid_map_path: null });
    expect(res.structuredContent.guidMapPath).toBeNull();
  });

  it('falls back to the storey LongName, as model_extract does', async () => {
    await writeFile(join(tmp, 'revit.ifc'), model('R', '02').replace("'02',$,$,#40,$,$,.ELEMENT.", "'02',$,$,#40,$,'Level 2',.ELEMENT."), 'utf-8');
    ctx.registry.remove('a');
    ctx.registry.add(await loadIfcModel(join(tmp, 'revit.ifc'), { modelId: 'r' }));
    const res = await call('model_anonymize', { storey: 'Level 2', file_path: join(tmp, 'anon-long.ifc') });
    expect(res.structuredContent.seedCount).toBe(3);
    await call('model_extract', { storeys: ['Level 2'], file_path: join(tmp, 'extract-long.ifc') });
    const text = await readFile(join(tmp, 'extract-long.ifc'), 'utf-8');
    for (const name of ['Wall A R', 'Wall B R', 'Slab R']) expect(text).toContain(`'${name}'`);
  });

  it('accepts a storey express id written as #id', async () => {
    const res = await call('model_anonymize', { storey: '#41', file_path: join(tmp, 'anon-hash.ifc') });
    expect(res.structuredContent.seedCount).toBe(3);
  });

  it('fails loudly on a storey that does not exist', async () => {
    await expect(call('model_anonymize', { storey: 'Level 9', file_path: join(tmp, 'x.ifc') })).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
  });
});

describe('model_simplify and model_lod on a real model (wasm)', () => {
  beforeEach(async () => {
    ctx.registry.remove('a');
    ctx.registry.add(await loadIfcModel(HELLO_WALL, { modelId: 'hw' }));
  });

  it('model_simplify at level 5 replaces element bodies with box face sets and the IFC still loads', async () => {
    const out = join(tmp, 'simple.ifc');
    const res = await call('model_simplify', { level: 5, file_path: out });
    expectMatchesOutputSchema('model_simplify', res.structuredContent);
    const s = res.structuredContent as { simplified: number; replaced: number; trianglesAfter: number; trianglesBefore: number; bytes: number };
    expect(s.replaced).toBeGreaterThan(0);
    expect(s.trianglesAfter).toBeLessThan(s.trianglesBefore);
    expect((await readFile(out)).length).toBe(s.bytes);
    // Level 5 is a bounding box per element: 12 triangles each, written as one face set per replacement.
    expect(s.trianglesAfter).toBe(12 * s.simplified);
    const written = await readFile(out, 'latin1');
    expect((written.match(/IFCTRIANGULATEDFACESET\(/g) ?? []).length).toBeGreaterThanOrEqual(s.replaced);
    const reloaded = await loadIfcModel(out, { modelId: 'r' });
    expect(reloaded.bim.query().byType('IfcTriangulatedFaceSet').toArray().length).toBeGreaterThan(0);
  }, 60_000);

  it('model_lod level 1 on a model with no geometry reports the box fallback as degraded', async () => {
    ctx.registry.add(await loadIfcModel(join(tmp, 'a.ifc'), { modelId: 'a' }));
    // No mesh: generateLod1 falls back to LOD0 boxes and says so, as `ifc-lite lod` does.
    const res = await call('model_lod', { model_id: 'a', level: 1, file_path: join(tmp, 'boxes-lod1.glb') });
    expect(res.structuredContent).toMatchObject({ status: 'degraded' });
    expect(res.content[0]).toMatchObject({ text: expect.stringContaining('degraded') });
  }, 60_000);

  it('model_lod level 0 writes one JSON row per element; level 1 writes a GLB and its metadata', async () => {
    const json = join(tmp, 'lod0.json');
    const res0 = await call('model_lod', { level: 0, file_path: json });
    expectMatchesOutputSchema('model_lod', res0.structuredContent);
    const lod0 = JSON.parse(await readFile(json, 'utf-8')) as { elements: { expressID: number }[] };
    expect(lod0.elements.length).toBe(res0.structuredContent.elementCount);
    const wallIds = ctx.registry.get('hw')!.bim.query().byType('IfcWall').toArray().map((e) => e.ref.expressId);
    expect(wallIds.length).toBeGreaterThan(0);
    for (const id of wallIds) expect(lod0.elements.map((e) => e.expressID)).toContain(id);

    const glb = join(tmp, 'lod1.glb');
    const meta = join(tmp, 'lod1.json');
    const res1 = await call('model_lod', { level: 1, file_path: glb, meta_path: meta });
    expectMatchesOutputSchema('model_lod', res1.structuredContent);
    expect((await readFile(glb)).subarray(0, 4).toString('latin1')).toBe('glTF');
    const metaJson = JSON.parse(await readFile(meta, 'utf-8')) as { lod: number; mapping: Record<string, unknown> };
    expect(metaJson.lod).toBe(1);
    for (const id of wallIds) expect(metaJson.mapping[String(id)]).toMatchObject({ node: expect.any(Number) });
  }, 60_000);
});
