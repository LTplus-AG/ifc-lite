/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7403: a prohibited specification (`<applicability maxOccurs="0">`) fails
 * at specification level through cardinality, but every element it applied to
 * came back `passed: true` (it has no requirements, so `allPassed` stayed
 * true). Element results, counts and status then disagreed: passedCount 1,
 * failedCount 0, status fail. Per IDS 1.0 each applicable element of a
 * prohibited specification is itself the violation.
 *
 * Driven through a real parsed STEP model and a real IDS document, the same
 * path the issue's reproduction takes.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createDataAccessor } from '../bridge/data-accessor.js';
import { parseIDS } from '../parser/xml-parser.js';
import { createTranslationService } from '../translation/service.js';
import { validateIDS } from './validator.js';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('probe.ifc','2026-10-10T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#20=IFCWALL('0000000000000000000020',$,'W-1',$,$,$,$,$,$);
#21=IFCSLAB('0000000000000000000021',$,'S-1',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

const ids = (requirements = '') => `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>probe</title></info>
  <specifications>
    <specification name="no walls allowed" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="0"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      ${requirements}
    </specification>
  </specifications>
</ids>`;

async function validate(idsXml: string, options: Parameters<typeof validateIDS>[3] = {}) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer, { disableWorkerScan: true });
  return validateIDS(parseIDS(idsXml), createDataAccessor(store),
    { modelId: 'probe', schemaVersion: 'IFC4', entityCount: store.entityCount }, options);
}

describe('prohibited specification element results (#7403)', () => {
  it('reports each applicable element as failed, so element results, counts and status agree', async () => {
    const report = await validate(ids(), { includePassingEntities: true });
    const result = report.specificationResults[0];

    expect(result.status).toBe('fail');
    expect(result.cardinalityResult?.passed).toBe(false);
    expect(result.applicableCount).toBe(1);
    expect(result.passedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.passRate).toBe(0);

    expect(result.entityResults).toHaveLength(1);
    const wall = result.entityResults[0];
    expect(wall.entityName).toBe('W-1');
    expect(wall.passed).toBe(false);
    // The element carries the reason it failed, so per-element and
    // per-requirement consumers (tables, BCF) have something to show.
    const failing = wall.requirementResults.filter((r) => r.status === 'fail');
    expect(failing).toHaveLength(1);
    expect(failing[0].requirement.optionality).toBe('prohibited');
    expect(failing[0].facetType).toBe('entity');
    expect(failing[0].failureReason).toBeTruthy();

    expect(report.summary.totalEntitiesPassed).toBe(0);
    expect(report.summary.totalEntitiesFailed).toBe(1);
  });

  it('keeps the failing element when passing entities are omitted', async () => {
    const report = await validate(ids(), { includePassingEntities: false });
    const result = report.specificationResults[0];
    expect(result.entityResults.map((e) => [e.entityName, e.passed])).toEqual([['W-1', false]]);
    expect(result.passedCount).toBe(0);
    expect(result.failedCount).toBe(1);
  });

  it('fails the element even when it satisfies requirements the specification declares', async () => {
    const report = await validate(ids(
      '<requirements><attribute><name><simpleValue>Name</simpleValue></name></attribute></requirements>',
    ));
    const wall = report.specificationResults[0].entityResults[0];
    expect(wall.passed).toBe(false);
    // The declared requirement is still evaluated and still passes; the
    // prohibition is reported alongside it, not instead of it.
    expect(wall.requirementResults.map((r) => [r.requirement.optionality, r.status])).toEqual([
      ['required', 'pass'],
      ['prohibited', 'fail'],
    ]);
  });

  it('renders a complete translated reason, with no unfilled placeholder', async () => {
    const translator = createTranslationService('en');
    const report = await validate(ids(), { translator });
    const reason = report.specificationResults[0].entityResults[0].requirementResults[0].failureReason ?? '';
    expect(reason).toContain('IfcWall');
    expect(reason).not.toMatch(/\{\w+\}/);
  });

  it('control: a prohibited specification with no matches still passes', async () => {
    const report = await validate(ids().replace('IFCWALL', 'IFCDOOR'));
    const result = report.specificationResults[0];
    expect(result.status).toBe('pass');
    expect(result.applicableCount).toBe(0);
    expect(result.entityResults).toEqual([]);
  });
});
