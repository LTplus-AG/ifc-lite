/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An information-validation report in a document (#6372), end to end: a real
 * `runRuleSet` run over inline STEP, snapshotted by `idsReportBlockFromReport`,
 * then laid out by `composeDocument` exactly as the PDF prints it. Nothing here
 * hand-builds a `ValidationReport`, so a field the engine stops emitting (or
 * the snapshot stops copying) fails a test rather than a fixture.
 *
 * Fixture: three IfcSpace (two named "Office", one "Lobby") and two IfcWall
 * (Wall A with FireRating 2HR, Wall B with 1HR). Rules:
 *  - `unique`    (error):   space names unique → the two Offices fail, set row "Office";
 *  - `count`     (warning): spaces per name ≥ 2, at least 4 spaces → Lobby's group
 *                           fails, and the 3 applicable spaces miss the cardinality;
 *  - `fire`      (error):   an element rule with its one requirement;
 *  - `broken`    (error):   a ReDoS-rejected applicability regex, so the engine
 *                           cannot evaluate it and reports `error`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { Rule, runRuleSet, type InformationRule, type RuleSetFile } from '@ifc-lite/rules';
import type { ValidationReport } from '@ifc-lite/ids';
import { idsReportBlockFromReport } from './ids-report.js';
import { composeDocument, estimateTextWidth } from './compose.js';
import type { IdsReportBlock } from './types.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0Proj000000000000000001',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#501= IFCSPACE('0Space00000000000000501',$,'Office',$,$,#40,$,$,.ELEMENT.,$);
#502= IFCSPACE('0Space00000000000000502',$,'Office',$,$,#40,$,$,.ELEMENT.,$);
#503= IFCSPACE('0Space00000000000000503',$,'Lobby',$,$,#40,$,$,.ELEMENT.,$);
#401= IFCWALL('0WallA0000000000000001A',$,'Wall A',$,$,#40,$,'tag',$);
#410= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2HR'),$);
#412= IFCPROPERTYSET('0Pset00000000000000412A',$,'Pset_WallCommon',$,(#410));
#413= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000413A',$,$,$,(#401),#412);
#402= IFCWALL('0WallB0000000000000002A',$,'Wall B',$,$,#40,$,'tag',$);
#430= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);
#431= IFCPROPERTYSET('0Pset00000000000000431A',$,'Pset_WallCommon',$,(#430));
#432= IFCRELDEFINESBYPROPERTIES('0Rel00000000000000432A',$,$,$,(#402),#431);
ENDSEC;
END-ISO-10303-21;
`;

const spaces = { groups: [{ rules: [Rule.ifcType(['IfcSpace'])], combinator: 'AND' as const }], authoredAs: 'chips' as const };
const walls = { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' as const }], authoredAs: 'chips' as const };

const RULES: InformationRule[] = [
  { id: 'unique', name: 'Space names are unique', applicability: spaces, requirement: { kind: 'unique', subject: { kind: 'name' } } },
  {
    id: 'count', name: 'At least two spaces per name', severity: 'warning', applicability: spaces,
    requirement: { kind: 'aggregate', fn: 'count', groupBy: { subject: { kind: 'name' } }, op: 'gte', value: 2 },
    cardinality: { minApplicable: 4 },
  },
  {
    id: 'fire', name: 'Walls are rated 2HR', applicability: walls,
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')], combinator: 'AND' }], authoredAs: 'chips' } },
  },
  {
    id: 'broken', name: 'Unevaluable rule',
    applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall']), { kind: 'name', op: 'matches', value: '(a+)+$' }], combinator: 'AND' }], authoredAs: 'chips' },
    requirement: { kind: 'element', block: { groups: [{ rules: [Rule.property('Pset_WallCommon', 'FireRating', 'eq', '2HR')], combinator: 'AND' }], authoredAs: 'chips' } },
  },
];

async function runFixture(): Promise<{ report: ValidationReport; block: IdsReportBlock }> {
  const bytes = new TextEncoder().encode(IFC);
  const store: IfcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const ruleSet: RuleSetFile = { version: 1, name: 'Delivery rules', rules: RULES };
  const report = await runRuleSet({ ruleSet, models: [{ id: 'm1', store }] });
  return { report, block: idsReportBlockFromReport(report, 'block') };
}

function pdfLines(block: IdsReportBlock): string[] {
  const layout = composeDocument({ name: 'Doc', page: { size: 'A4', orientation: 'portrait' }, generatedAt: 'now', measure: estimateTextWidth, blocks: [block] });
  return layout.pages.flatMap((page) => page.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])));
}

const checkOf = (block: IdsReportBlock, id: string) => {
  const check = block.checks.find((c) => c.id === id);
  assert.ok(check, `no check ${id}`);
  return check!;
};

describe('information validation report block (#6372)', () => {
  it('records its source kind and prints "Information validation report", never "IDS report"', async () => {
    const { block } = await runFixture();
    assert.equal(block.sourceKind, 'rules');
    assert.equal(block.sourceName, 'Delivery rules');
    const lines = pdfLines(block);
    assert.equal(lines[0], 'Information validation report: Delivery rules');
    assert.equal(lines.some((line) => line.includes('IDS report')), false);
  });

  it('counts warning-severity failures apart from failures, in the summary and on the check', async () => {
    const { report, block } = await runFixture();
    const count = checkOf(block, 'count');
    assert.equal(count.severity, 'warning');
    assert.equal(checkOf(block, 'unique').severity, undefined, 'an error rule carries no severity marker');
    const engineCount = report.specificationResults.find((r) => r.specification.id === 'count')!;
    assert.ok(engineCount.failedCount > 0, 'the fixture makes the warning rule fail');
    const allFailed = report.specificationResults.reduce((sum, r) => sum + r.failedCount, 0);
    assert.equal(block.summary.warnings, engineCount.failedCount);
    assert.equal(block.summary.failed, allFailed - engineCount.failedCount);

    const lines = pdfLines(block);
    assert.ok(lines.includes(`Checked ${block.summary.checked} · Passed ${block.summary.passed} · Failed ${block.summary.failed} · Warnings ${block.summary.warnings} · ${block.summary.passRate}% passed`));
    assert.ok(lines.includes(`Warning · Checked 3 · Passed ${count.passed} · Warnings ${count.failed} · ${count.passRate}%`));
  });

  it('gives unique/aggregate rules exact counts plus their set rows and cardinality, never "partial report"', async () => {
    const { report, block } = await runFixture();
    const unique = checkOf(block, 'unique');
    assert.deepEqual([unique.checked, unique.passed, unique.failed, unique.passRate], [3, 1, 2, 33]);
    assert.deepEqual(unique.sets, [{ label: 'Office', actual: 'Office (2×)', expected: 'unique', passed: false }]);

    const count = checkOf(block, 'count');
    const engineSets = report.specificationResults.find((r) => r.specification.id === 'count')!.setResults ?? [];
    assert.equal(engineSets.length, 2, 'one set per space name');
    assert.deepEqual(count.sets, engineSets.map((s) => ({ label: s.label, groupKey: s.groupKey, actual: s.actual, expected: s.expected, passed: s.passed })));
    assert.deepEqual(count.cardinality, { passed: false, actual: 3, min: 4 });

    const lines = pdfLines(block);
    assert.equal(lines.some((line) => line.includes('partial report')), false);
    assert.ok(lines.includes('Actual Office (2×) · Expected unique · Failed'));
    assert.ok(lines.includes('Found 3 · Expected at least 4 · Not met'));
    const lobby = engineSets.find((s) => !s.passed)!;
    assert.ok(lines.includes(`Actual ${lobby.actual} · Expected ${lobby.expected} · Warning`), 'a warning rule\'s failing set reads Warning');
  });

  it('prints the engine error for a rule it could not evaluate, instead of 0/0/0%', async () => {
    const { report, block } = await runFixture();
    const engineError = report.specificationResults.find((r) => r.specification.id === 'broken')!.error;
    assert.ok(engineError, 'the fixture makes the rule unevaluable');
    assert.equal(checkOf(block, 'broken').error, engineError);
    const lines = pdfLines(block);
    const at = lines.indexOf('Unevaluable rule');
    assert.equal(lines[at + 1], `Could not be evaluated: ${engineError}`);
    assert.equal(lines.some((line) => line.startsWith('Checked 0 · Passed 0 · Failed 0')), false);
  });

  it('does not repeat a single-requirement rule as its own child row', async () => {
    const { report, block } = await runFixture();
    const fire = report.specificationResults.find((r) => r.specification.id === 'fire')!;
    const requirementIds = new Set(fire.entityResults.flatMap((e) => e.requirementResults.map((r) => r.requirement.id)));
    assert.equal(requirementIds.size, 1, 'the engine reports one requirement for the rule');
    for (const check of block.checks) assert.deepEqual(check.rules, [], `${check.id} has no child rule rows`);
    const lines = pdfLines(block);
    const at = lines.indexOf('Walls are rated 2HR');
    assert.equal(lines[at + 1], 'Checked 2 · Passed 1 · Failed 1 · 50%');
    assert.equal(lines[at + 2], 'Unevaluable rule', 'the next line is the next rule, not a child row');
  });
});

describe('information validation set rows keep a blank group (#6372 review)', () => {
  it('snapshots an empty groupKey as a group, and prints it as "(blank)" rather than dropping the grouping', async () => {
    // Walls contained in a storey with no Name, counted per parent: the engine
    // reports that group with groupKey '' (an unnamed parent), not undefined.
    const contained = IFC.replace('ENDSEC;\nEND-ISO-10303-21;', [
      "#100= IFCBUILDINGSTOREY('0Storey0000000000000100',$,$,$,$,#40,$,$,.ELEMENT.,0.);",
      "#101= IFCRELCONTAINEDINSPATIALSTRUCTURE('0Rel00000000000000101A',$,$,$,(#401,#402),#100);",
      'ENDSEC;', 'END-ISO-10303-21;',
    ].join('\n'));
    const bytes = new TextEncoder().encode(contained);
    const store: IfcDataStore = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const perParent: InformationRule = {
      id: 'per-parent', name: 'Three walls per storey', applicability: walls,
      requirement: { kind: 'aggregate', fn: 'count', groupBy: { subject: { kind: 'parent' } }, op: 'gte', value: 3 },
    };
    const report = await runRuleSet({ ruleSet: { version: 1, name: 'Blank', rules: [perParent] }, models: [{ id: 'm1', store }] });
    const blank = report.specificationResults[0].setResults?.find((s) => s.groupKey === '');
    assert.ok(blank, 'the engine reports a set for the unnamed storey');
    const block = idsReportBlockFromReport(report, 'b');
    assert.ok(block.checks[0].sets?.some((s) => s.groupKey === ''), 'the snapshot keeps groupKey "" instead of dropping it');
    assert.ok(pdfLines(block).includes(`${blank.label} · (blank)`), 'the PDF names the blank group');
  });
});
