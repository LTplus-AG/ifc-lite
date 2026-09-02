/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutation-targeted coverage for `query_entities`' shaping/formatting and
 * `count_entities`' `group_by` sort — the largest untested file in this
 * package before this file existed.
 *
 * Fixtures are built so a mutant cannot hide behind a symmetry:
 *  - `shapeEntities` fixtures give every entity a *distinct* value per field
 *    (name/description/objectType/globalId), so a field swap or drop changes
 *    the output rather than agreeing with it by accident, and include one
 *    entity that omits the optional attributes so a "always fill in X"
 *    mutant is observable.
 *  - `formatQueryResult` fixtures include an exact single-entity result (the
 *    "entity" vs "entities" pluralization boundary) and a >25-item page (the
 *    "+N more" boundary), rather than only in-range sizes.
 *  - `count_entities` group_by fixtures are inserted in an order that is
 *    NOT already sorted by count, with an explicit tie, so a reversed or
 *    no-op sort produces a different, wrong, order rather than an
 *    indistinguishable one.
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
import { queryTools } from './query.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

function step(body: string): string {
  return `ISO-10303-21;
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
${body}
ENDSEC;
END-ISO-10303-21;
`;
}

let tmp: string;
const ctx: ToolContext = {
  registry: new InMemoryModelRegistry(),
  scope: fullScope(),
  progress: NOOP_PROGRESS,
  log: SILENT_LOGGER,
  signal: new AbortController().signal,
  config: { ...DEFAULT_CONFIG },
};

async function load(id: string, content: string): Promise<void> {
  const path = join(tmp, `${id}.ifc`);
  await writeFile(path, content, 'utf-8');
  ctx.registry.add(await loadIfcModel(path, { modelId: id }));
}

function tool(name: string) {
  const t = queryTools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
}

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const result = await tool(name).handler(input, ctx);
  expect(result.isError).toBeUndefined();
  return result;
}

function text(result: CallToolResult): string {
  const block = result.content.find((c) => c.type === 'text') as { text: string } | undefined;
  if (!block) throw new Error('no text block');
  return block.text;
}

// -- Fixture 1: shapeEntities / formatQueryResult -----------------------

// Every field distinct per wall, so a swap (e.g. type<->objectType, or
// name<->description) changes the observed output instead of matching it.
// WALC omits every optional attribute, so a "fill in a default" mutant on
// the projection is observable too.
const SHAPE_MODEL = step(`
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('${guid('WALA')}',$,'Name A','Desc A','Type A',#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Name B','Desc B','Type B',#40,$,'tagB',$);
#74= IFCWALL('${guid('WALC')}',$,$,$,$,#40,$,'tagC',$);
`);

// -- Fixture 2: a >25-row page, to observe the "+N more" line -----------

function manyWallsBody(n: number): string {
  const lines: string[] = [`#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);`];
  for (let i = 0; i < n; i++) {
    const ref = 100 + i;
    const g = `W${i}`.padEnd(4, '0');
    lines.push(`#${ref}= IFCWALL('${guid(g)}',$,'Wall ${i}',$,$,#40,$,'tag${i}',$);`);
  }
  return lines.join('\n');
}
const MANY_MODEL = step(manyWallsBody(26));

// -- Fixture 3: count_entities group_by storey ---------------------------
//
// Insertion order A(1), B(3), C(2), D(2) is deliberately NOT the descending
// order the sort must produce (B,3)(C or D,2)(C or D,2)(A,1). A reversed or
// dropped comparator leaves the insertion order (or the exact opposite),
// either of which fails the assertion below. C and D tie at count 2, so the
// comparator's tie-breaking is exercised too (only ordering *between* the
// count-3 and count-1 groups is asserted, since a `(a,b)=>b-a` comparator
// is not required to be stable across the tie).
const GROUP_MODEL = step(`
#41= IFCBUILDINGSTOREY('${guid('STOA')}',$,'Storey A',$,$,#40,$,$,.ELEMENT.,0.);
#42= IFCBUILDINGSTOREY('${guid('STOB')}',$,'Storey B',$,$,#40,$,$,.ELEMENT.,0.);
#43= IFCBUILDINGSTOREY('${guid('STOC')}',$,'Storey C',$,$,#40,$,$,.ELEMENT.,0.);
#44= IFCBUILDINGSTOREY('${guid('STOD')}',$,'Storey D',$,$,#40,$,$,.ELEMENT.,0.);
#50= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#51= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#50));
#52= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#50,(#41,#42,#43,#44));
#60= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RC1')}',$,$,$,(#70),#41);
#61= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RC2')}',$,$,$,(#71,#72,#73),#42);
#62= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RC3')}',$,$,$,(#74,#75),#43);
#63= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RC4')}',$,$,$,(#76,#77),#44);
#70= IFCWALL('${guid('WA')}',$,'A',$,$,#40,$,'tA',$);
#71= IFCWALL('${guid('WB1')}',$,'B1',$,$,#40,$,'tB1',$);
#72= IFCWALL('${guid('WB2')}',$,'B2',$,$,#40,$,'tB2',$);
#73= IFCWALL('${guid('WB3')}',$,'B3',$,$,#40,$,'tB3',$);
#74= IFCWALL('${guid('WC1')}',$,'C1',$,$,#40,$,'tC1',$);
#75= IFCWALL('${guid('WC2')}',$,'C2',$,$,#40,$,'tC2',$);
#76= IFCWALL('${guid('WD1')}',$,'D1',$,$,#40,$,'tD1',$);
#77= IFCWALL('${guid('WD2')}',$,'D2',$,$,#40,$,'tD2',$);
`);

// -- Fixture 4: count_entities/materials_list group_by material -----------
//
// #72's material resolves to an `IfcMaterialList` (two named materials, no
// list-level Name — MaterialData carries the names under `.materials[]`,
// not `.name`) and #73's to a plain `IfcMaterial` (name at the top level).
// A consumer that only reads `mat?.name` sees #72 as materialless.
const MATERIAL_MODEL = step(`
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('${guid('WALL')}',$,'Listed Wall',$,$,#40,$,'tagL',$);
#73= IFCWALL('${guid('WALP')}',$,'Plain Wall',$,$,#40,$,'tagP',$);
#80= IFCMATERIAL('Steel',$,$);
#81= IFCMATERIAL('Concrete',$,$);
#82= IFCMATERIALLIST((#80,#81));
#83= IFCMATERIAL('Timber',$,$);
#90= IFCRELASSOCIATESMATERIAL('${guid('RAM1')}',$,$,$,(#72),#82);
#91= IFCRELASSOCIATESMATERIAL('${guid('RAM2')}',$,$,$,(#73),#83);
`);

// -- Fixture 5: materials_list — blank/whitespace-only material names -----
//
// Regression coverage for #3515's own bug: `materialFallbackName` chains
// candidates with `??`, which only falls through on null/undefined. A
// present-but-blank `Name` (`IFCMATERIAL('',$,$)`) or a whitespace-only one
// short-circuits the chain and is returned verbatim instead of falling
// through to the next candidate / the caller's `(unnamed)` placeholder.
//
// #172 -> IfcMaterialList([blank material]): the only candidate is blank.
// #173 -> IfcMaterialList([whitespace-only material]): only candidate is
//   whitespace, a real shape per issue #3714 (E57 whitespace-only attrs).
// #174 -> IfcMaterialList([genuine name]): must still return unchanged.
// #175 -> IfcMaterialList(()): empty list — control, already correct on
//   main; must not regress to something other than the caller's fallback.
const MATERIAL_BLANK_MODEL = step(`
#141= IFCBUILDINGSTOREY('${guid('STRB')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#172= IFCWALL('${guid('WBLK')}',$,'Blank Wall',$,$,#40,$,'tagBlank',$);
#173= IFCWALL('${guid('WWSP')}',$,'Whitespace Wall',$,$,#40,$,'tagWs',$);
#174= IFCWALL('${guid('WGEN')}',$,'Genuine Wall',$,$,#40,$,'tagGen',$);
#175= IFCWALL('${guid('WEMP')}',$,'Empty List Wall',$,$,#40,$,'tagEmpty',$);
#180= IFCMATERIAL('',$,$);
#181= IFCMATERIAL('   ',$,$);
#182= IFCMATERIAL('Concrete',$,$);
#190= IFCMATERIALLIST((#180));
#191= IFCMATERIALLIST((#181));
#192= IFCMATERIALLIST((#182));
#193= IFCMATERIALLIST(());
#200= IFCRELASSOCIATESMATERIAL('${guid('RAM3')}',$,$,$,(#172),#190);
#201= IFCRELASSOCIATESMATERIAL('${guid('RAM4')}',$,$,$,(#173),#191);
#202= IFCRELASSOCIATESMATERIAL('${guid('RAM5')}',$,$,$,(#174),#192);
#203= IFCRELASSOCIATESMATERIAL('${guid('RAM6')}',$,$,$,(#175),#193);
`);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-query-'));
  await load('shape', SHAPE_MODEL);
  await load('many', MANY_MODEL);
  await load('group', GROUP_MODEL);
  await load('material', MATERIAL_MODEL);
  await load('materialBlank', MATERIAL_BLANK_MODEL);
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('query_entities → shapeEntities (default fields)', () => {
  it('carries every default field distinctly, not swapped or defaulted', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall', fields: [] });
    const entities = (out.structuredContent as { entities: Array<Record<string, unknown>> }).entities;
    const a = entities.find((e) => e.globalId === guid('WALA'));
    expect(a).toBeDefined();
    expect(a?.name).toBe('Name A');
    expect(a?.description).toBe('Desc A');
    expect(a?.objectType).toBe('Type A');
    expect(a?.type).toBe('IfcWall');
    expect(a?.expressId).toBe(72);
    expect(a?.modelId).toBe('shape');
  });

  it('an entity with no optional attributes gets them as null/undefined, not filled in from another row', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall', fields: [] });
    const entities = (out.structuredContent as { entities: Array<Record<string, unknown>> }).entities;
    const c = entities.find((e) => e.globalId === guid('WALC'));
    expect(c).toBeDefined();
    expect(c?.name).toBeFalsy();
    expect(c?.description).toBeFalsy();
    expect(c?.objectType).toBeFalsy();
  });
});

describe('query_entities → shapeEntities (explicit `fields` subset)', () => {
  it('includes only the requested field plus expressId — not neighbouring fields', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall', fields: ['name'] });
    const entities = (out.structuredContent as { entities: Array<Record<string, unknown>> }).entities;
    const a = entities.find((e) => e.expressId === 72) as Record<string, unknown>;
    expect(a.name).toBe('Name A');
    expect('type' in a).toBe(false);
    expect('globalId' in a).toBe(false);
    expect('description' in a).toBe(false);
    expect('objectType' in a).toBe(false);
  });

  it('a different single field is carried through its own guard, not the neighbour’s', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall', fields: ['objectType'] });
    const entities = (out.structuredContent as { entities: Array<Record<string, unknown>> }).entities;
    const a = entities.find((e) => e.expressId === 72) as Record<string, unknown>;
    expect(a.objectType).toBe('Type A');
    expect('name' in a).toBe(false);
    expect('type' in a).toBe(false);
  });
});

describe('formatQueryResult', () => {
  it('singular "entity" for exactly one match — the pluralization boundary', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall', property: { pset: 'x', name: 'y', op: 'exists' } });
    // No pset named 'x' exists, so nothing matches — 0 is plural ("entities").
    expect(text(out)).toMatch(/^Found 0 matching entities\./);
  });

  it('singular "entity" really does trigger at count 1', async () => {
    const out = await call('query_entities', { model_id: 'shape', in_storey: guid('STOR'), limit: 1 });
    // Exact, like the 0- and 26-match cases above and below. This previously
    // read `/^Found \d+ matching entit(y|ies)/`, which matches BOTH renderings
    // — so the one test named for the pluralization boundary was the one test
    // that could not detect crossing it.
    //
    // The fixture yields exactly one match: with no `type` filter only product
    // types are candidates, `SHAPE_MODEL` declares no spatial-containment
    // relations, so `storey()` returns null for every wall and only the storey
    // itself (#41, the `guid('STOR')` this queries) resolves to itself.
    expect(text(out)).toMatch(/^Found 1 matching entity\./);
    // Filter down to a single concrete entity via express id round trip instead:
    const single = await call('get_entity', { model_id: 'shape', express_id: 72 });
    expect(single).toBeDefined();
  });

  it('an entity without a Name omits the quoted name, not a stale one', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall' });
    const line = text(out).split('\n').find((l) => l.includes('#74'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/'/);
    expect(line).toContain(`GlobalId=${guid('WALC')}`);
  });

  it('lists a GlobalId-bearing name-bearing row with both, quoted and tagged correctly', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall' });
    const line = text(out).split('\n').find((l) => l.includes('#72'));
    expect(line).toContain("'Name A'");
    expect(line).toContain(`GlobalId=${guid('WALA')}`);
    expect(line).toContain('IfcWall');
  });

  it('a page over 25 rows lists exactly 25 and reports the true remainder — the +N-more boundary', async () => {
    const out = await call('query_entities', { model_id: 'many', type: 'IfcWall', limit: 1000 });
    const body = text(out);
    const lines = body.split('\n');
    // Header + 25 rows + one "+N more" line.
    expect(lines[0]).toMatch(/^Found 26 matching entities\./);
    const bulletLines = lines.slice(1).filter((l) => l.startsWith('  • Ifc'));
    expect(bulletLines).toHaveLength(25);
    const moreLine = lines[lines.length - 1];
    expect(moreLine).toBe('  • … +1 more in this page');
  });

  it('at or under 25 rows lists them all with no "+N more" line', async () => {
    const out = await call('query_entities', { model_id: 'shape', type: 'IfcWall' });
    const body = text(out);
    expect(body).not.toContain('more in this page');
  });
});

describe('count_entities → group_by sort', () => {
  it('groups by storey in descending count order, not insertion order or ascending', async () => {
    const out = await call('count_entities', { model_id: 'group', type: 'IfcWall', group_by: 'storey' });
    const groups = (out.structuredContent as { groups: Array<{ key: string; count: number }> }).groups;
    const counts = groups.map((g) => g.count);
    // Correct: [3, 2, 2, 1] (B first, A last). Insertion order was
    // [1, 3, 2, 2] (A, B, C, D) and a reversed comparator gives [1, 2, 2, 3].
    // Both are distinguishable from the correct result.
    expect(counts).toEqual([3, 2, 2, 1]);
    expect(groups[0].key).toBe('Storey B');
    expect(groups[groups.length - 1].key).toBe('Storey A');
    // The tied pair (C, D) is present in some order between the extremes.
    const tiedKeys = groups.slice(1, 3).map((g) => g.key).sort();
    expect(tiedKeys).toEqual(['Storey C', 'Storey D']);
  });

  it('total across groups is the full count, not just the largest group', async () => {
    const out = await call('count_entities', { model_id: 'group', type: 'IfcWall', group_by: 'storey' });
    const structured = out.structuredContent as { total: number };
    expect(structured.total).toBe(8);
  });
});

describe('count_entities → group_by material', () => {
  it('groups an IfcMaterialList entity under its material names, not "(no material)"', async () => {
    const out = await call('count_entities', { model_id: 'material', type: 'IfcWall', group_by: 'material' });
    const groups = (out.structuredContent as { groups: Array<{ key: string; count: number }> }).groups;
    const keys = groups.map((g) => g.key);
    expect(keys).not.toContain('(no material)');
    expect(keys).toContain('Timber');
    // The list-material wall must land under one of its real material names,
    // not be silently dropped into the "no material" bucket.
    expect(keys.some((k) => k === 'Steel' || k === 'Concrete')).toBe(true);
  });
});

describe('materials_list', () => {
  it('reports the IfcMaterialList wall under a real material name, not "(unnamed)"', async () => {
    const out = await call('materials_list', { model_id: 'material' });
    const materials = (out.structuredContent as { materials: Array<{ name: string; count: number }> }).materials;
    const names = materials.map((m) => m.name);
    expect(names).not.toContain('(unnamed)');
    expect(names).toContain('Timber');
    expect(names.some((n) => n === 'Steel' || n === 'Concrete')).toBe(true);
  });
});

describe('materials_list → blank/whitespace material names (regression: #3515 blank fallthrough)', () => {
  it('a blank Name ("") falls through to "(unnamed)", not an empty-string entry', async () => {
    const out = await call('materials_list', { model_id: 'materialBlank' });
    const materials = (out.structuredContent as { materials: Array<{ name: string; count: number }> }).materials;
    const names = materials.map((m) => m.name);
    expect(names).not.toContain('');
  });

  it('a whitespace-only Name ("   ") falls through to "(unnamed)", not a whitespace entry', async () => {
    const out = await call('materials_list', { model_id: 'materialBlank' });
    const materials = (out.structuredContent as { materials: Array<{ name: string; count: number }> }).materials;
    const names = materials.map((m) => m.name);
    expect(names).not.toContain('   ');
  });

  it('a genuine name is still returned unchanged', async () => {
    const out = await call('materials_list', { model_id: 'materialBlank' });
    const materials = (out.structuredContent as { materials: Array<{ name: string; count: number }> }).materials;
    const names = materials.map((m) => m.name);
    expect(names).toContain('Concrete');
  });

  it('an empty IfcMaterialList still yields "(unnamed)" (control — already correct on main)', async () => {
    const out = await call('materials_list', { model_id: 'materialBlank' });
    const materials = (out.structuredContent as { materials: Array<{ name: string; count: number }> }).materials;
    const unnamedCount = materials.find((m) => m.name === '(unnamed)')?.count ?? 0;
    // Blank, whitespace, and truly-empty-list walls all collapse into the
    // same "(unnamed)" bucket: 3 of the 4 fixture walls.
    expect(unnamedCount).toBe(3);
  });

  it('the text summary never renders a blank bullet line', async () => {
    const out = await call('materials_list', { model_id: 'materialBlank' });
    const summary = text(out);
    expect(summary).not.toMatch(/•\s*—/);
  });
});

describe("get_entities_bulk → include: ['attributes']", () => {
  // The schema declares `include` with `default: ['attributes']` and no enum
  // restricting its values, matching `get_entity`'s vocabulary
  // ('attributes','properties','quantities','classifications','materials').
  // `get_entity` honours 'attributes' by attaching `bim.attributes(ref)`
  // (the full EXPRESS attribute list — Tag, PredefinedType, etc. — which is
  // NOT part of the base `EntityData` shape returned by `bim.entity(ref)`).
  // `get_entities_bulk`'s handler checks 'properties' / 'quantities' /
  // 'classifications' / 'materials' but never 'attributes', so the
  // documented default silently does nothing: the field an agent asked for
  // by name never appears, with no error and a 200-shaped success result.
  it('attaches the full attribute list when include names it, like get_entity does', async () => {
    const single = await call('get_entity', { model_id: 'shape', global_id: guid('WALA'), include: ['attributes'] });
    const singleAttrs = (single.structuredContent as { attributes: unknown[] }).attributes;
    expect(singleAttrs.length).toBeGreaterThan(0);

    const bulk = await call('get_entities_bulk', {
      model_id: 'shape',
      global_ids: [guid('WALA')],
      include: ['attributes'],
    });
    const entities = (bulk.structuredContent as { entities: Record<string, { attributes?: unknown[] }> }).entities;
    expect(entities[guid('WALA')].attributes).toBeDefined();
    expect((entities[guid('WALA')].attributes as unknown[]).length).toBeGreaterThan(0);
  });
});
