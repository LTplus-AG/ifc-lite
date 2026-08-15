/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The numbers `model_audit` and `ids_validate` report.
 *
 * `read-after-write.test.ts` covers which *issues* the audit raises over a
 * mutation overlay, but nothing covered the arithmetic that turns those issues
 * into the Lighthouse-style scores an agent actually reads and reports onward —
 * `scoreFromIssues` could stop weighting warnings entirely and the suite stayed
 * green. Nor did anything cover `summarizeIdsReport`'s empty-specification rule,
 * where `specPassed = ents.length > 0` could become `= true` and a rule that
 * matched no entity at all would be counted as passed. Both failures are silent
 * in the worst way: the tool still returns a confident, plausible score.
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
import { validationTools } from './validation.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

const PREAMBLE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
`;

const TAIL = `ENDSEC;
END-ISO-10303-21;
`;

/**
 * Project + Site + Building, every required entity present, one named wall.
 * The only structural finding is the missing IfcBuildingStorey, which is a
 * *warning* — which is exactly what makes this fixture able to discriminate
 * the warning weight from the error weight.
 */
const WARNING_ONLY = PREAMBLE + `#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#2= IFCSITE('${guid('SITE')}',$,'Site',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#3= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
` + TAIL;

/** Same, but with a storey present and the Site missing — one *error*, no warning. */
const ERROR_ONLY = PREAMBLE + `#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#3= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#4= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
` + TAIL;

/** Everything present, but one of two walls carries no Name. */
const UNNAMED = PREAMBLE + `#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#2= IFCSITE('${guid('SITE')}',$,'Site',$,$,#40,$,$,.ELEMENT.,$,$,$,$,$);
#3= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#4= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,$,$,$,#40,$,'tagB',$);
` + TAIL;

interface AuditShape {
  overall: number;
  scores: { structure: number; identity: number; dataQuality: number };
  issues: Array<{ severity: string; category: string; rule: string; message: string }>;
  totals: { products: number; unnamed: number; duplicateGlobalIds: number };
}

interface IdsShape {
  summary: {
    totalSpecifications: number;
    passedSpecifications: number;
    failedSpecifications: number;
    totalEntities: number;
    passedEntities: number;
    failedEntities: number;
  };
}

function tool(name: string) {
  const found = validationTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

let tmp: string;

async function auditOf(file: string): Promise<AuditShape> {
  return (await run(file, 'model_audit', {})).structuredContent as unknown as AuditShape;
}

async function run(file: string, name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const ctx: ToolContext = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, file), { modelId: 'm' }));
  return tool(name).handler(input, ctx);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-validation-'));
  await writeFile(join(tmp, 'warning-only.ifc'), WARNING_ONLY, 'utf-8');
  await writeFile(join(tmp, 'error-only.ifc'), ERROR_ONLY, 'utf-8');
  await writeFile(join(tmp, 'unnamed.ifc'), UNNAMED, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('model_audit scoring', () => {
  it('docks a structural warning 10 points, distinctly from an error', async () => {
    const warned = await auditOf('warning-only.ifc');
    // Exactly one structural finding, and it is a warning — so the score below
    // is attributable to the warning weight and nothing else.
    expect(warned.issues.filter((i) => i.category === 'structure')).toEqual([
      expect.objectContaining({ severity: 'warning', rule: 'has-storeys' }),
    ]);
    expect(warned.scores.structure).toBe(90);
  });

  it('docks a structural error 25 points', async () => {
    const errored = await auditOf('error-only.ifc');
    expect(errored.issues.filter((i) => i.category === 'structure')).toEqual([
      expect.objectContaining({ severity: 'error', rule: 'required-entity' }),
    ]);
    // 25 ≠ 10, so the two weights cannot be collapsed into one and still
    // satisfy both tests.
    expect(errored.scores.structure).toBe(75);
  });

  it('scores dataQuality on the share of *named* products', async () => {
    const audit = await auditOf('unnamed.ifc');
    // Four products (project, site, building, storey are spatial; the two walls
    // and the spatial containers that `isProductType` accepts make up the
    // denominator) — pinned, because a denominator that silently grew to
    // include geometry primitives is the #2003-class defect this score had.
    expect(audit.totals.unnamed).toBe(1);
    expect(audit.totals.products).toBe(6);
    expect(audit.scores.dataQuality).toBe(83);
    expect(audit.issues.map((i) => i.rule)).toContain('has-name');
  });

  it('scores a clean identity at 100 and averages the three categories', async () => {
    const audit = await auditOf('warning-only.ifc');
    expect(audit.totals.duplicateGlobalIds).toBe(0);
    expect(audit.scores.identity).toBe(100);
    expect(audit.overall).toBe(
      Math.round((audit.scores.structure + audit.scores.identity + audit.scores.dataQuality) / 3),
    );
  });
});

const IDS_MATCHING_NOTHING = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS"
     xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>Unmatched</title></info>
  <specifications>
    <specification name="Furniture must be named" ifcVersion="IFC4">
      <applicability>
        <entity><name><simpleValue>IFCFURNITURE</simpleValue></name></entity>
      </applicability>
      <requirements>
        <attribute><name><simpleValue>Name</simpleValue></name></attribute>
      </requirements>
    </specification>
  </specifications>
</ids>`;

const IDS_MATCHING_WALLS = `<?xml version="1.0" encoding="utf-8"?>
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

describe('ids_validate summary', () => {
  it('does not count a specification that matched no entity as passed', async () => {
    // The vacuous-pass rule. A spec whose applicability selects nothing has an
    // empty `entityResults`; counting it as passed is how an IDS typo turns
    // into a green report, which is the single most misleading thing this tool
    // can tell an agent.
    const out = (await run('warning-only.ifc', 'ids_validate', {
      ids_xml: IDS_MATCHING_NOTHING,
    })).structuredContent as unknown as IdsShape;
    expect(out.summary.totalSpecifications).toBe(1);
    expect(out.summary.totalEntities).toBe(0);
    expect(out.summary.passedSpecifications).toBe(0);
    expect(out.summary.failedSpecifications).toBe(1);
  });

  it('counts a specification whose matched entities all pass', async () => {
    // Counter-example: with the same requirement against a spec that *does*
    // match, the pass is real — so the failure above is about emptiness, not
    // about `passedSpecifications` being stuck at zero.
    const out = (await run('warning-only.ifc', 'ids_validate', {
      ids_xml: IDS_MATCHING_WALLS,
    })).structuredContent as unknown as IdsShape;
    expect(out.summary.totalEntities).toBeGreaterThan(0);
    expect(out.summary.failedEntities).toBe(0);
    expect(out.summary.passedSpecifications).toBe(1);
    expect(out.summary.failedSpecifications).toBe(0);
  });

  it('reports failures when a matched entity does not satisfy the requirement', async () => {
    const out = (await run('unnamed.ifc', 'ids_validate', {
      ids_xml: IDS_MATCHING_WALLS,
    })).structuredContent as unknown as IdsShape;
    expect(out.summary.totalEntities).toBe(2);
    expect(out.summary.failedEntities).toBe(1);
    expect(out.summary.passedEntities).toBe(1);
    expect(out.summary.passedSpecifications).toBe(0);
  });
});

describe('ids source resolution', () => {
  it('rejects a call that supplies neither ids_xml nor ids_path', async () => {
    await expect(run('warning-only.ifc', 'ids_validate', {})).rejects.toThrow(/ids_xml or ids_path/);
    await expect(run('warning-only.ifc', 'ids_explain', {})).rejects.toThrow(/ids_xml or ids_path/);
  });

  it('applies the allowedPaths guard to ids_explain, not only to ids_validate', async () => {
    // Both tools share `loadIdsXml` so both enforce the allowlist; a path
    // outside it must be refused rather than read.
    await expect(run('warning-only.ifc', 'ids_explain', { ids_path: '/etc/hosts' }))
      .rejects.toThrow(/outside allowed roots|sensitive home entry/i);
  });

  it('errors when the named specification is not in the document', async () => {
    await expect(run('warning-only.ifc', 'ids_explain', {
      ids_xml: IDS_MATCHING_WALLS, spec_name: 'No such spec',
    })).rejects.toThrow(/not found in IDS document/);
  });
});

describe('gherkin_check', () => {
  it('reports UNSUPPORTED_OPERATION rather than silently passing', async () => {
    await expect(run('warning-only.ifc', 'gherkin_check', {}))
      .rejects.toThrow(/gherkin_check is planned/);
  });
});
