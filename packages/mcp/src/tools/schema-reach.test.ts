/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two agent-facing surfaces that asked the IFC4 codegen pin a question about
 * a file it cannot answer (#2003).
 *
 * `model_audit`'s GlobalId-uniqueness rule skipped any type whose inheritance
 * chain did not reach `IfcRoot`, and the pin answers an empty chain for the 39
 * IFC2X3 and 80 IFC4X3 `IfcRoot` classes it has no row for. So the audit scored
 * an IFC2X3 file clean on identity without having looked at it.
 *
 * `schema_describe` refused those same classes outright — "Unknown IFC entity
 * type" for a class the agent could have just found with `query_entities` on the
 * file it is holding.
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
import { discoveryTools } from './discovery.js';
import { validationTools } from './validation.js';

function buildIfc(schema: string, dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

const PREAMBLE = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
];

/** Two IfcScheduleTimeControls under one GlobalId — the class exists in IFC2X3
 *  only, so the IFC4 pin has no chain for it. */
const DUPLICATE = buildIfc('IFC2X3', [
  ...PREAMBLE,
  "#50=IFCSCHEDULETIMECONTROL('0Dupe_GUID_00000001',$,'Ctrl A',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
  "#51=IFCSCHEDULETIMECONTROL('0Dupe_GUID_00000001',$,'Ctrl B',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
]);

/** The same file with distinct GlobalIds, plus two same-named resource entities
 *  the rule must keep out — the parser keys those on the Name in slot 0. */
const CLEAN = buildIfc('IFC2X3', [
  ...PREAMBLE,
  "#50=IFCSCHEDULETIMECONTROL('0Ctrl_GUID_00000001',$,'Ctrl A',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
  "#51=IFCSCHEDULETIMECONTROL('0Ctrl_GUID_00000002',$,'Ctrl B',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
  "#60=IFCMATERIAL('Concrete');",
  "#61=IFCMATERIAL('Concrete');",
]);

interface AuditShape {
  issues: Array<{ severity: string; category: string; rule: string; message: string }>;
}

interface SchemaShape {
  type: string;
  parent: string | null;
  isAbstract: boolean;
  inheritanceChain: string[];
  attributes: Array<{ name: string; type?: string }>;
  schemaSource: string;
}

let tmp: string;
let ctx: ToolContext;

const ALL_TOOLS = [...discoveryTools, ...validationTools];

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  const result = await tool.handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result;
}

async function duplicateRules(modelId: string): Promise<string[]> {
  const out = (await call('model_audit', { model_id: modelId })).structuredContent as unknown as AuditShape;
  return out.issues.filter((i) => i.rule === 'duplicate-globalid').map((i) => i.message);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-schema-reach-'));
  await writeFile(join(tmp, 'dup.ifc'), DUPLICATE, 'utf-8');
  await writeFile(join(tmp, 'clean.ifc'), CLEAN, 'utf-8');
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'dup.ifc'), { modelId: 'dup' }));
  ctx.registry.add(await loadIfcModel(join(tmp, 'clean.ifc'), { modelId: 'clean' }));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('model_audit GlobalId uniqueness outside the IFC4 pin', () => {
  it('reports the duplicate on an IFC2X3-only class', async () => {
    expect(await duplicateRules('dup')).toEqual([
      'Duplicate GlobalId 0Dupe_GUID_00000001 on 2 entities',
    ]);
  });

  it('stays quiet on the clean twin, resource entities included', async () => {
    // Two IfcMaterials named 'Concrete' both answer 'Concrete' from the
    // columnar parser's positional GlobalId column. They are not IfcRoot
    // subtypes in any bundled schema, so the chain check keeps them out — which
    // is exactly what the check is for.
    expect(await duplicateRules('clean')).toEqual([]);
  });
});

describe('schema_describe outside the IFC4 pin', () => {
  it('describes an IFC2X3-only class instead of calling it unknown', async () => {
    const out = (await call('schema_describe', { type: 'IfcScheduleTimeControl' }))
      .structuredContent as unknown as SchemaShape;

    expect(out.type).toBe('IfcScheduleTimeControl');
    expect(out.parent).toBe('IfcControl');
    expect(out.schemaSource).toBe('bundled-schema-union');
    // Root→leaf, the order this tool has always reported.
    expect(out.inheritanceChain[0]).toBe('IfcRoot');
    expect(out.inheritanceChain[out.inheritanceChain.length - 1]).toBe('IfcScheduleTimeControl');
    expect(out.inheritanceChain).toContain('IfcObjectDefinition');
    expect(out.attributes.map((a) => a.name).slice(0, 4)).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description',
    ]);
  });

  it('describes an IFC4X3-only class the same way', async () => {
    const out = (await call('schema_describe', { type: 'IfcCourse' }))
      .structuredContent as unknown as SchemaShape;
    expect(out.schemaSource).toBe('bundled-schema-union');
    expect(out.inheritanceChain).toContain('IfcBuiltElement');
    expect(out.inheritanceChain[0]).toBe('IfcRoot');
  });

  it('keeps the pinned answer byte-for-byte for a class the pin carries', async () => {
    const out = (await call('schema_describe', { type: 'IfcBeam' }))
      .structuredContent as unknown as SchemaShape;

    expect(out.schemaSource).toBe('IFC4_ADD2_TC1');
    // The union would answer IFC4X3's rename here. Reporting IfcBuiltElement as
    // an IFC4 IfcBeam's supertype would be a new wrong answer traded for an old
    // one, so the pin stays primary for every class it carries.
    expect(out.inheritanceChain).toContain('IfcBuildingElement');
    expect(out.inheritanceChain).not.toContain('IfcBuiltElement');
    expect(out.inheritanceChain).toEqual([
      'IfcRoot', 'IfcObjectDefinition', 'IfcObject', 'IfcProduct', 'IfcElement',
      'IfcBuildingElement', 'IfcBeam',
    ]);
    // Attribute types survive on the pinned path; the union has names only.
    expect(out.attributes[0]).toMatchObject({ name: 'GlobalId', type: 'IfcGloballyUniqueId' });
  });

  it('subtracts the parent from the schema that declares the class', async () => {
    const out = (await call('schema_describe', {
      type: 'IfcScheduleTimeControl', include_inherited: false,
    })).structuredContent as unknown as SchemaShape;

    // `IfcEntityInfo.attributes` is inherited + direct, so `include_inherited:
    // false` subtracts the parent's count — and the parent has to be IFC2X3's
    // `IfcControl` (5 attributes), not the merged union's (6, because IFC4
    // added `Identification`). Taking the union's count ate `ActualStart`, the
    // class's first own attribute. 67 bundled classes are exposed to this.
    expect(out.attributes.map((a) => a.name)[0]).toBe('ActualStart');
    expect(out.attributes).toHaveLength(18);

    const all = (await call('schema_describe', { type: 'IfcScheduleTimeControl' }))
      .structuredContent as unknown as SchemaShape;
    expect(all.attributes).toHaveLength(23);
    expect(all.attributes.map((a) => a.name).slice(0, 5)).toEqual([
      'GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType',
    ]);
  });

  it('resolves the parent in the leaf\'s own schema, not in the merged union', async () => {
    // `IfcGeneralProfileProperties` is IFC2X3-only. Its parent
    // `IfcProfileProperties` has 2 attributes in IFC2X3 and 4 in the merged
    // union (IFC4 added ProfileName/ProfileDefinition ahead of them), so taking
    // the union's row reports two attributes the class does not own. 16 bundled
    // classes are exposed to this.
    const out = (await call('schema_describe', {
      type: 'IfcGeneralProfileProperties', include_inherited: false,
    })).structuredContent as unknown as SchemaShape;

    expect(out.attributes.map((a) => a.name)).toEqual([
      'PhysicalWeight', 'Perimeter', 'MinimumPlateThickness', 'MaximumPlateThickness', 'CrossSectionArea',
    ]);
  });

  it('still rejects a name no bundled schema declares', async () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'schema_describe');
    if (!tool) throw new Error('schema_describe not registered');
    await expect(async () => tool.handler({ type: 'IfcAcmeVendorExtension' }, ctx))
      .rejects.toThrow(/Unknown IFC entity type/);
  });
});
