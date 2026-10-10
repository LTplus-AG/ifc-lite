/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS, type IDSValidationReport, type ValidatorOptions } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { installLayout } from '@/test/dom-layout.js';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { registerLocale, setLocale } from '@/i18n';
import { IDSPanel } from './IDSPanel.js';
import { buildReportHTML } from '@/hooks/ids/idsExportService';

installLayout();
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); setLocale('en'); });

// #6551 invariant: three of four checks pass, but only one of two walls
// passes every requirement. Both summaries come from actual parsed STEP.
const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Synthetic regression'),'2;1');
FILE_NAME('synthetic.ifc','2026-01-01T00:00:00',(),(),'Test','Test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,$,'A',.STANDARD.);
#2=IFCWALL('0Wall00000000000000002',$,'Wall B',$,$,$,$,'B',.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;
const xml = `<ids xmlns="http://standards.buildingsmart.org/IDS">
<info><title>Synthetic check totals</title></info><specifications>
<specification name="Walls" ifcVersion="IFC4" identifier="walls">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements>
<attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute>
<attribute cardinality="required"><name><simpleValue>Tag</simpleValue></name><value><simpleValue>A</simpleValue></value></attribute>
</requirements></specification></specifications></ids>`;

async function validate(options: ValidatorOptions = {}, idsXml = xml) {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, {});
  return validateIDS(parseIDS(idsXml), createDataAccessor(store),
    { modelId: 'synthetic', schemaVersion: 'IFC4', entityCount: 2 }, options);
}
function mount(report: IDSValidationReport) {
  useViewerStore.setState({ idsDocument: report.source.document, idsValidationReport: report,
    idsAuditReport: null, idsError: null, idsLoading: false, idsProgress: null });
  return render(<IDSPanel />);
}

it('shows check totals alongside explicit entity–specification results (#6551)', async () => {
  const report = await validate();
  assert.equal(report.summary.totalEntitiesPassed, 1);
  const ui = mount(report);
  const checks = ui.querySelector('section[aria-label="Requirement checks"]');
  assert.ok(checks, 'the results panel must mount the check summary');
  assert.match(checks.textContent ?? '', /3\/4 checks passed \(75%\)/);
  assert.match(checks.textContent ?? '', /1\/2 requirements passed/);
  assert.match(ui.textContent ?? '', /Entity–specification results/);
  assert.match(ui.textContent ?? '', /50%/);
  assert.match(ui.textContent ?? '', /once per applicable specification/);
});

it('keeps complete totals when passing entities are omitted (#6551)', async () => {
  const report = await validate({ includePassingEntities: false });
  assert.equal(report.specificationResults[0].entityResults.length, 1);
  const ui = mount(report);
  assert.match(ui.textContent ?? '', /3\/4 checks passed \(75%\)/);
  assert.match(ui.textContent ?? '', /1\/2 requirements passed/);
  const html = buildReportHTML(report, 'en');
  assert.match(html, /3 of 4 element&ndash;requirement checks passed/);
  assert.match(html, /75%/);
});

it('counts the same entity again when another specification checks it (#6551)', async () => {
  const ids = parseIDS(xml);
  ids.specifications.push({ ...ids.specifications[0], id: 'walls-again', name: 'Walls again' });
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, {});
  const report = await validateIDS(ids, createDataAccessor(store), { modelId: 'synthetic', schemaVersion: 'IFC4', entityCount: 2 });
  const ui = mount(report);
  assert.match(ui.textContent ?? '', /6\/8 checks passed \(75%\)/);
  assert.match(ui.textContent ?? '', /2\/4 requirements passed/);
  assert.equal(report.summary.totalEntitiesChecked, 4);
});

it('shows no evaluated checks for an empty population (#6551)', async () => {
  const ui = mount(await validate({}, xml.replace('IFCWALL', 'IFCDOOR')));
  const checks = ui.querySelector('section[aria-label="Requirement checks"]');
  assert.match(checks?.textContent ?? '', /No requirement checks evaluated/);
  assert.doesNotMatch(checks?.textContent ?? '', /100%/);
});

it('fails requirements when a required specification matches no entities (#6551)', async () => {
  const ui = mount(await validate({}, xml.replace('IFCWALL', 'IFCDOOR').replace('minOccurs="0"', 'minOccurs="1"')));
  assert.match(ui.textContent ?? '', /0\/2 requirements passed/);
  assert.match(ui.textContent ?? '', /No requirement checks evaluated/);
});

it('formats check counts using the active locale (#6551)', async () => {
  registerLocale('ar-EG-u-nu-arab', {});
  setLocale('ar-EG-u-nu-arab');
  const ui = mount(await validate());
  const formatter = new Intl.NumberFormat('ar-EG-u-nu-arab');
  assert.ok(ui.textContent?.includes(`${formatter.format(3)}/${formatter.format(4)} checks passed`));
});

it('uses each result specification when IDS identifiers repeat (#6551)', async () => {
  const extra = `<specification name="Names" ifcVersion="IFC4" identifier="walls">
<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
<requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
</specification>`;
  const repeatedXml = xml.replace('<value><simpleValue>A</simpleValue></value>', '')
    .replace('</specifications>', `${extra}</specifications>`);
  for (const includePassingEntities of [true, false]) {
    const report = await validate({ includePassingEntities }, repeatedXml);
    assert.equal(report.specificationResults[0].specification.id, report.specificationResults[1].specification.id);
    const ui = mount(report);
    assert.match(ui.textContent ?? '', /6\/6 checks passed \(100%\)/);
    assert.match(ui.textContent ?? '', /3\/3 requirements passed/);
    cleanup();
  }
});

it('keeps cardinality failure distinct from passing requirement checks (#6551)', async () => {
  const report = await validate({}, xml.replace('<value><simpleValue>A</simpleValue></value>', '')
    .replace('maxOccurs="unbounded"', 'maxOccurs="0"'));
  const ui = mount(report);
  assert.equal(report.summary.failedSpecifications, 1);
  assert.equal(report.summary.overallPassRate, 0);
  assert.match(ui.textContent ?? '', /0\/1 Specifications Passed/);
  // The declared requirements still pass on both walls (4 checks), but each
  // wall is a match of a prohibited specification, so each also fails one
  // prohibition check and the walls themselves fail (#7403).
  assert.equal(report.summary.totalEntitiesFailed, 2);
  assert.match(ui.textContent ?? '', /2\/2 requirements passed/);
  assert.match(ui.textContent ?? '', /4\/6 checks passed \(66%\)/);
});

it('counts optional absence and prohibited matches using the validator verdicts (#6551)', async () => {
  const optionalXml = xml.replace('<attribute cardinality="required"><name><simpleValue>Name',
    '<attribute cardinality="optional"><name><simpleValue>Description')
    .replace('<attribute cardinality="required"><name><simpleValue>Tag',
      '<attribute cardinality="prohibited"><name><simpleValue>Tag');
  const report = await validate({}, optionalXml);
  const ui = mount(report);
  assert.match(ui.textContent ?? '', /3\/4 checks passed \(75%\)/);
  assert.match(ui.textContent ?? '', /1\/2 requirements passed/);
});

it('suppresses check aggregates for capped validation (#6551)', async () => {
  const report = await validate({ maxEntities: 1 });
  assert.equal(report.specificationResults[0].applicableCount, 2);
  assert.equal(report.specificationResults[0].entityResults.length, 1);
  const ui = mount(report);
  assert.equal(ui.querySelector('section[aria-label="Requirement checks"]'), null);
  assert.match(ui.textContent ?? '', /Entity–specification results/);
  assert.match(buildReportHTML(report, 'en'), /Requirement check totals unavailable for this incomplete report/);
});

it('suppresses check aggregates when a specification cannot be evaluated (#6551)', async () => {
  const unsafeXml = xml.replace('<simpleValue>A</simpleValue>',
    '<xs:restriction xmlns:xs="http://www.w3.org/2001/XMLSchema" base="xs:string"><xs:pattern value="(a+)+b"/></xs:restriction>');
  const report = await validate({}, unsafeXml);
  assert.match(report.specificationResults[0].error ?? '', /rejected/i);
  const ui = mount(report);
  assert.equal(ui.querySelector('section[aria-label="Requirement checks"]'), null);
  assert.match(ui.textContent ?? '', /0\/1 Specifications Passed/);
  assert.match(buildReportHTML(report, 'en'), /Requirement check totals unavailable for this incomplete report/);
});
