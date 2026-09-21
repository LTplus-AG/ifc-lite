/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite check` (#5138 PR 7b) — runs a `.rules.json` information-validation
 * rule set through the SAME `@ifc-lite/rules` engine the viewer's Data
 * Validation panel runs, and reports the tri-state exit code the brief for
 * issue #5138 PR 7b specifies: 0 all pass / 1 any fail / 2 any rule error or
 * unreadable input.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuleSetFile } from '@ifc-lite/rules';
import type { ValidationReport } from '@ifc-lite/ids';
import { checkCommand } from './check.js';

function silenceOutput() {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return write;
}

function jsonWritten(write: ReturnType<typeof silenceOutput>): ValidationReport {
  const calls = write.mock.calls.map(c => String(c[0]));
  return JSON.parse(calls.join('')) as ValidationReport;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ifc-lite-check-'));
}

// Two named walls, each with a Pset_WallCommon.FireRating and a
// Qto_WallBaseQuantities.Width — every rule below passes against this model.
const TWO_WALLS = [
  'ISO-10303-21;', 'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#40=IFCLOCALPLACEMENT($,$);",
  "#401=IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,#40,$,'tag',$);",
  "#410=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);",
  "#412=IFCPROPERTYSET('0Pset00000000000000412A',$,'Pset_WallCommon',$,(#410));",
  "#413=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);",
  "#420=IFCQUANTITYLENGTH('Width',$,$,0.3,$);",
  "#421=IFCELEMENTQUANTITY('0Qto00000000000000421A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#420));",
  "#422=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000422A',$,$,$,(#401),#421);",
  "#402=IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,#40,$,'tag',$);",
  "#430=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);",
  "#431=IFCPROPERTYSET('0Pset00000000000000431A',$,'Pset_WallCommon',$,(#430));",
  "#432=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000432A',$,$,$,(#402),#431);",
  "#440=IFCQUANTITYLENGTH('Width',$,$,0.2,$);",
  "#441=IFCELEMENTQUANTITY('0Qto00000000000000441A',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#440));",
  "#442=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000442A',$,$,$,(#402),#441);",
  'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n');

// Same two walls, plus a third with NO Pset_WallCommon at all — the
// element rule's `ne` on that absent property FAILS it (never vacuously
// passes, plan §4 item 2), so this model fails the rule set overall.
const THREE_WALLS = TWO_WALLS.replace(
  'ENDSEC;\nEND-ISO-10303-21;',
  "#403=IFCWALL('0WallC0000000000000003A',$,'Wall C',$,$,#40,$,'tag',$);\nENDSEC;\nEND-ISO-10303-21;",
);

function ruleSet(includeUnsafeApplicabilityRegex = false): RuleSetFile {
  return {
    version: 1,
    name: 'delivery check',
    rules: [
      {
        id: 'fire-rating-set',
        name: 'FireRating must not be NOPE',
        applicability: {
          groups: [{
            rules: [
              { kind: 'ifcType', values: ['IfcWall'], op: 'in' },
              // #5138 PR 7b exit-2 fixture: `matches` compiles the pattern
              // through @ifc-lite/regex-guard, which THROWS on a
              // catastrophic-backtracking shape — the engine's own
              // try/catch turns that into `SpecificationResult.error`
              // rather than crashing the run (rule-engine.ts).
              ...(includeUnsafeApplicabilityRegex ? [{ kind: 'name' as const, op: 'matches' as const, value: '(a+)+$' }] : []),
            ],
            combinator: 'AND' as const,
          }],
          authoredAs: 'chips' as const,
        },
        requirement: {
          kind: 'element' as const,
          block: {
            groups: [{ rules: [{ kind: 'property' as const, setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'ne' as const, value: 'NOPE' }], combinator: 'AND' as const }],
            authoredAs: 'chips' as const,
          },
        },
      },
      {
        id: 'unique-name',
        name: 'Wall names must be unique',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'unique', subject: { kind: 'name' } },
      },
      {
        id: 'width-sum',
        name: 'Total wall width at least 0.4m',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: {
          kind: 'aggregate', fn: 'sum',
          subject: { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width' },
          op: 'gte', value: 0.4,
        },
      },
    ],
  };
}

function writeFixtures(dir: string, ifc: string, rules: RuleSetFile): { modelPath: string; rulesPath: string } {
  const modelPath = join(dir, 'model.ifc');
  const rulesPath = join(dir, 'checks.rules.json');
  writeFileSync(modelPath, ifc);
  writeFileSync(rulesPath, JSON.stringify(rules));
  return { modelPath, rulesPath };
}

describe('ifc-lite check — tri-state exit code (#5138)', () => {
  it('exit 0: every rule passes on the clean two-wall model', async () => {
    const { modelPath, rulesPath } = writeFixtures(tmpDir(), TWO_WALLS, ruleSet());
    const write = silenceOutput();
    await checkCommand([modelPath, '--rules', rulesPath, '--format', 'json']);
    const report = jsonWritten(write);
    expect(report.source.kind).toBe('rules');
    expect(report.specificationResults.every(r => r.status === 'pass')).toBe(true);
    expect(process.exitCode).toBe(0);
  });

  it('exit 1: Wall C has no Pset_WallCommon, so `ne` fails on it (not vacuously true)', async () => {
    const { modelPath, rulesPath } = writeFixtures(tmpDir(), THREE_WALLS, ruleSet());
    const write = silenceOutput();
    await checkCommand([modelPath, '--rules', rulesPath, '--format', 'json']);
    const report = jsonWritten(write);
    const fireRatingSpec = report.specificationResults.find(r => r.specification.id === 'fire-rating-set');
    expect(fireRatingSpec?.status).toBe('fail');
    const wallC = fireRatingSpec?.entityResults.find(e => e.entityName === 'Wall C');
    expect(wallC?.passed).toBe(false);
    expect(wallC?.requirementResults[0].failureReason).toBe('absent');
    expect(process.exitCode).toBe(1);
  });

  it('exit 2: an unevaluable rule (ReDoS-rejected regex) always wins over a would-be pass', async () => {
    const { modelPath, rulesPath } = writeFixtures(tmpDir(), TWO_WALLS, ruleSet(true));
    const write = silenceOutput();
    await checkCommand([modelPath, '--rules', rulesPath, '--format', 'json']);
    const report = jsonWritten(write);
    const fireRatingSpec = report.specificationResults.find(r => r.specification.id === 'fire-rating-set');
    expect(fireRatingSpec?.error).toBeTruthy();
    expect(process.exitCode).toBe(2);
  });

  it('exit 2: targets.modelFingerprints naming a fingerprint no loaded model matches (#5138 PR 7b review)', async () => {
    // The CLI's `filterIdentity` (`@ifc-lite/cache`'s `computeSourceFingerprint`,
    // prefixed with the file's base name, exactly matching what the viewer
    // stores as `FederatedModel.sourceFingerprint`) will never equal a
    // fabricated fingerprint — this proves the mismatch reports `error`
    // (exit 2), never a silent "nothing to check" pass (exit 0).
    const targetedRules: RuleSetFile = {
      version: 1,
      name: 'targeted',
      targets: { modelFingerprints: ['this-fingerprint-matches-nothing'] },
      rules: [{
        id: 'wall-named',
        name: 'Walls must be named',
        applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
        requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'name', op: 'ne', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
      }],
    };
    const { modelPath, rulesPath } = writeFixtures(tmpDir(), TWO_WALLS, targetedRules);
    const write = silenceOutput();
    await checkCommand([modelPath, '--rules', rulesPath, '--format', 'json']);
    const report = jsonWritten(write);
    expect(report.modelInfo).toHaveLength(0);
    expect(report.specificationResults[0].error).toBe('no loaded model matches the rule set targets');
    expect(process.exitCode).toBe(2);
  });

  it('table format prints one line per rule with pass/fail counts', async () => {
    const { modelPath, rulesPath } = writeFixtures(tmpDir(), TWO_WALLS, ruleSet());
    const write = silenceOutput();
    await checkCommand([modelPath, '--rules', rulesPath]);
    const out = write.mock.calls.map(c => String(c[0])).join('');
    expect(out).toContain('FireRating must not be NOPE');
    expect(out).toMatch(/applicable=2 passed=2 failed=0/);
    expect(process.exitCode).toBe(0);
  });
});
