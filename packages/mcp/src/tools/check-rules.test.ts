/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `check_rules` (#5138 PR 7b) runs the SAME `@ifc-lite/rules` engine
 * `ifc-lite check` and the viewer's Data Validation panel run, against
 * whichever models are currently loaded in the MCP session.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { sourceModelIdentity } from '@ifc-lite/cache';
import { readFile } from 'node:fs/promises';
import { checkRulesTools } from './check-rules.js';

const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,$,$);
#40= IFCLOCALPLACEMENT($,$);
#72= IFCWALL('0Wall000000000000000072',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('0Wall000000000000000073',$,$,$,$,#40,$,'tagB',$);
ENDSEC;
END-ISO-10303-21;
`;

const NAMED_RULE_SET = {
  version: 1,
  name: 'walls named',
  rules: [
    {
      id: 'wall-name-required',
      name: 'Walls must have a non-empty Name',
      applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
      requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'name', op: 'ne', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
    },
  ],
};

const checkRules = checkRulesTools[0];

let tmp: string;

async function contextWithModel(): Promise<ToolContext> {
  const ctx: ToolContext = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'wall.ifc'), { modelId: 'm' }));
  return ctx;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-check-rules-'));
  await writeFile(join(tmp, 'wall.ifc'), WALL_IFC, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('check_rules', () => {
  it('runs an inline rules_json rule set: Wall A named -> passes, Wall B unnamed -> fails', async () => {
    const ctx = await contextWithModel();
    const result = await checkRules.handler({ rules_json: JSON.stringify(NAMED_RULE_SET) }, ctx);
    const report = (result.structuredContent as { report: { specificationResults: Array<{ status: string; entityResults: Array<{ entityName?: string; passed: boolean }> }> } }).report;
    const spec = report.specificationResults[0];
    expect(spec.status).toBe('fail');
    const byName = (n?: string) => spec.entityResults.find((e) => e.entityName === n);
    expect(byName('Wall A')?.passed).toBe(true);
    expect(byName(undefined)?.passed).toBe(false);
  });


  // The #5138 PR 7b review defect: `check_rules` mapped registry entries to
  // `{ id, store }`, dropping the model's source identity, so EVERY rule in a
  // viewer-authored rule set carrying `targets.modelFingerprints` came back
  // unevaluable instead of being evaluated.
  it('evaluates a rule set whose targets name this model by the fingerprint the viewer stores', async () => {
    const ctx = await contextWithModel();
    const bytes = await readFile(join(tmp, 'wall.ifc'));
    const targeted = {
      ...NAMED_RULE_SET,
      targets: { modelFingerprints: [sourceModelIdentity('wall.ifc', bytes)] },
    };
    const result = await checkRules.handler({ rules_json: JSON.stringify(targeted) }, ctx);
    const report = (result.structuredContent as { report: { specificationResults: Array<{ status: string; error?: string; applicableCount: number }> } }).report;
    const spec = report.specificationResults[0];
    expect(spec.error).toBeUndefined();
    expect(spec.applicableCount).toBe(2);
    expect(spec.status).toBe('fail');
  });

  it('reports a rule as unevaluable when its targets match no loaded model, never a silent pass', async () => {
    const ctx = await contextWithModel();
    const targeted = { ...NAMED_RULE_SET, targets: { modelFingerprints: ['wall.ifc:deadbeef'] } };
    const result = await checkRules.handler({ rules_json: JSON.stringify(targeted) }, ctx);
    const report = (result.structuredContent as { report: { specificationResults: Array<{ status: string; error?: string }> } }).report;
    expect(report.specificationResults[0].error).toMatch(/no loaded model matches/i);
    expect(report.specificationResults[0].status).toBe('fail');
  });

  it('rejects invalid rule-set JSON with PARSE_FAILED, never a silent empty report', async () => {
    const ctx = await contextWithModel();
    await expect(checkRules.handler({ rules_json: '{ not json' }, ctx)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects when no model is loaded, never runs the engine against nothing', async () => {
    const ctx: ToolContext = {
      registry: new InMemoryModelRegistry(),
      scope: fullScope(),
      progress: NOOP_PROGRESS,
      log: SILENT_LOGGER,
      signal: new AbortController().signal,
      config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
    };
    await expect(checkRules.handler({ rules_json: JSON.stringify(NAMED_RULE_SET) }, ctx)).rejects.toThrow(/No models loaded/);
  });
});
