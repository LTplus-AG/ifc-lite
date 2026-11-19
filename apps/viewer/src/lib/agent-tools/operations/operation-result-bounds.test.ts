/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reads stay under the operation result limit on large libraries and models, and expected-state tokens stay small
 * (#10794, rows of #10695). Imports only what main exports, so the revert oracle can load it with the fix reverted.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { clashGroupLibrary, useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { model, parseStep, seed, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { DEFAULT_ANONYMIZE_TOGGLES } from '@/components/viewer/anonymized-export/AnonymizationOptionsPanel';
import { MAX_RESULT_BYTES } from './result-limit';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial); useClashGroupLibrary.setState({ entries: [] }); resetFeaturesForTest(); });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const pad = (n: number) => 'x'.repeat(n);
let host = viewerHost();
const run = (operation_id: string, input: unknown = {}, model_id?: string) => dispatchMainViewerTool(host, 'viewer_operation_execute',
  { ...(model_id ? { model_id } : {}), operation_id, input }, { canEdit: () => true });
function json<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  assert.ok(bytes(result.structured) <= MAX_RESULT_BYTES);
  const value = (result.structured as { result: { native_json?: string } }).result;
  return (value.native_json === undefined ? value : JSON.parse(value.native_json)) as T;
}
/** Read every page of a paged list operation; each page must fit the limit on its own. */
async function readAll<T>(operation: string, field: string, page = (value: Record<string, unknown>) => value as { next_offset: number | null }) {
  const items: T[] = []; let offset: number | null = 0, token = '';
  while (offset !== null) {
    const value: Record<string, unknown> = json(await run(operation, { offset }));
    items.push(...value[field] as T[]); token = (value.expected_reports ?? value.expected_library ?? value.configuration_revision) as string;
    offset = page(value).next_offset;
  }
  return { items, token };
}
const step = (body: string[]) => new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('b.ifc','2026-11-19',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${body.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`);
const guid = (n: number) => String(n).padStart(22, '0');
/** An element assembly (#2) aggregating `count` walls (from #10). */
async function assemblyOf(count: number) {
  const walls = Array.from({ length: count }, (_, i) => 10 + i);
  const lines = [`#1=IFCPROJECT('${guid(1)}',$,'P',$,$,$,$,$,$);`, `#2=IFCELEMENTASSEMBLY('${guid(2)}',$,'Assembly',$,$,$,$,$,$,$);`,
    ...walls.map(id => `#${id}=IFCWALL('${guid(id)}',$,'W${id}',$,$,$,$,$,.STANDARD.);`),
    `#3=IFCRELAGGREGATES('${guid(3)}',$,$,$,#2,(${walls.map(id => `#${id}`).join(',')}));`];
  const store = await parseStep(step(lines)); seed([model('A', store)]); host = viewerHost(); return { store, walls };
}

describe('operation results and expected-state tokens stay bounded (#10794)', () => {
  it('#4 clash.reports.read pages a library over 1 MB and its expected_reports token stays short', async () => {
    const reports = Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, name: `Report ${i}`, evidence: pad(4000) }));
    useViewerStore.setState({ savedClashReports: reports as never, initializeSavedClashReports: async () => true });
    assert.ok(bytes(reports) > MAX_RESULT_BYTES, 'the fixture alone exceeds the limit');
    const { items, token } = await readAll<{ id: string }>('clash.reports.read', 'reports');
    assert.deepEqual(items.map(row => row.id), reports.map(row => row.id)); assert.ok(token.length <= 64);
    const stale = await run('clash.reports.write', { action: 'rename', id: 'r0', name: 'Renamed', report_json: '', expected_reports: '1:0' });
    assert.match(stale.text, /Saved reports changed/);
    const current = await run('clash.reports.write', { action: 'rename', id: 'r0', name: 'Renamed', report_json: '', expected_reports: token });
    assert.doesNotMatch(current.text, /Saved reports changed/);
  });

  it('#4 clash.groups.read pages a group library over 1 MB and its expected_library token stays short', async (t: TestContext) => {
    t.mock.method(clashGroupLibrary, 'initialize', async () => true);
    const entries = Array.from({ length: 300 }, (_, i) => ({ version: 1, id: `w${i}`, name: `Workspace ${i} ${pad(4000)}`, groups: [] }));
    useClashGroupLibrary.setState({ entries: entries as never });
    const { items, token } = await readAll<{ id: string }>('clash.groups.read', 'entries');
    assert.equal(items.length, entries.length); assert.ok(token.length <= 64);
    assert.match((await run('clash.groups.library', { action: 'select', workspace_id: 'w1', expected_library: '1:0' })).text, /Group library changed/);
    assert.doesNotMatch((await run('clash.groups.library', { action: 'select', workspace_id: 'w1', expected_library: token })).text, /Group library changed/);
  });

  it('#37 validation.reports.read pages a report library over 1 MB and its expected_reports token stays short', async () => {
    const reports = Array.from({ length: 400 }, (_, i) => ({ id: `v${i}`, name: `Validation ${i}`, snapshot: pad(4000) }));
    useViewerStore.setState({ savedValidationReports: reports as never, initializeValidationReports: async () => true });
    const { items, token } = await readAll<{ id: string }>('validation.reports.read', 'reports');
    assert.equal(items.length, reports.length); assert.ok(token.length <= 64);
    assert.match((await run('validation.reports.manage', { action: 'rename', id: 'missing', name: 'N', expected_reports: '1:0' })).text, /library changed/);
    assert.match((await run('validation.reports.manage', { action: 'rename', id: 'missing', name: 'N', expected_reports: token })).text, /Unknown saved native report/);
  });

  it('#29 zones.read pages assignments over 1 MB and returns one short configuration_revision', async () => {
    const setId = useViewerStore.getState().createZoneSet('Large');
    const record = { [setId]: { zoneId: null, zoneName: pad(60), straddles: false, touchedZoneIds: [] } };
    useViewerStore.setState({ zoneAssignments: new Map(Array.from({ length: 12000 }, (_, i) => [i + 1, record])) });
    const { items, token } = await readAll<unknown>('zones.read', 'assignments', value => value.assignments_page as { next_offset: number | null });
    assert.equal(items.length, 12000); assert.ok(token.length <= 64);
    const made = json<{ set_id: string; configuration_revision: string }>(await run('zones.set.create', { name: 'Next', expected_configuration: token }));
    assert.match((await run('zones.set.create', { name: 'Again', expected_configuration: token })).text, /configuration changed/);
    // The edit hands back the revision the next edit needs.
    assert.ok(json<{ set_id: string }>(await run('zones.set.create', { name: 'Again', expected_configuration: made.configuration_revision })).set_id);
  });

  it('#24 zones.writeback.prepare returns the row count and a bounded sample, not every row', async () => {
    const { walls } = await assemblyOf(6000);
    const setId = useViewerStore.getState().createZoneSet('Writeback'); useViewerStore.getState().addZone(setId, { name: `Zone ${pad(200)}`, center: [0, 0, 0], size: [1, 1, 1], rotationY: 0 });
    const zone = useViewerStore.getState().zoneSets[0].zones[0];
    useViewerStore.setState({ zoneAssignments: new Map(walls.map(id => [id, { [setId]: { zoneId: zone.id, zoneName: zone.name, straddles: false, touchedZoneIds: [zone.id] } }])) });
    const prepared = json<{ token: string; row_count: number; rows: unknown[]; truncated: boolean }>(await run('zones.writeback.prepare', { set_id: setId, model_ids: ['A'], basis: 'unqualified', action: 'write' }, 'A'));
    assert.ok(prepared.token); assert.ok(prepared.row_count >= walls.length);
    assert.equal(prepared.truncated, true); assert.ok(prepared.rows.length > 0 && prepared.rows.length < prepared.row_count);
  });

  const anon = { target_model_id: 'A', seed_ids: [2], excluded_ids: [], excluded_types: [], file_stem: 'anonymous', anonymize: { ...DEFAULT_ANONYMIZE_TOGGLES },
    relations: { IfcRelVoidsElement: false, IfcRelFillsElement: false, IfcRelAggregates: 'down', IfcRelNests: 'none', IfcRelDefinesByType: false, IfcRelAssociatesMaterial: false, IfcRelContainedInSpatialStructure: false, IfcRelDefinesByProperties: false, IfcRelConnectsPathElementsDepth: 0 } };

  it('#41 exports.anonymized.prepare reports a truncated relationship expansion', async () => {
    await assemblyOf(6000);
    const preview = json<{ truncated: boolean; included_ids: number[] }>(await run('exports.anonymized.prepare', anon));
    assert.equal(preview.truncated, true);
  });

  it('#74 exports.anonymized.prepare refuses a membership above the 100k id cap with a narrowing message', async () => {
    await assemblyOf(100_001);
    const result = await run('exports.anonymized.prepare', anon);
    assert.equal(result.isError, true); assert.match(result.text, /Narrow the selection/);
  });
});
