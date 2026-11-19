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
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { setGlobalRendererRef } from '@/hooks/useBCF';

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
async function readAll<T>(operation: string, field: string) {
  const items: T[] = []; let offset: number | null = 0, token = '';
  while (offset !== null) {
    const value: Record<string, unknown> = json(await run(operation, { offset }));
    items.push(...value[field] as T[]); token = (value.expected_reports ?? value.expected_library ?? value.configuration_revision) as string;
    offset = value.next_offset as number | null;
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
    assert.deepEqual(items.map(row => row.id), entries.map(row => row.id), 'every workspace once, in order'); assert.ok(token.length <= 64);
    assert.match((await run('clash.groups.library', { action: 'select', workspace_id: 'w1', expected_library: '1:0' })).text, /Group library changed/);
    assert.doesNotMatch((await run('clash.groups.library', { action: 'select', workspace_id: 'w1', expected_library: token })).text, /Group library changed/);
  });

  it('#37 validation.reports.read pages a report library over 1 MB and its expected_reports token stays short', async () => {
    const reports = Array.from({ length: 400 }, (_, i) => ({ id: `v${i}`, name: `Validation ${i}`, snapshot: pad(4000) }));
    useViewerStore.setState({ savedValidationReports: reports as never, initializeValidationReports: async () => true });
    const { items, token } = await readAll<{ id: string }>('validation.reports.read', 'reports');
    assert.deepEqual(items.map(row => row.id), reports.map(row => row.id), 'every report once, in order'); assert.ok(token.length <= 64);
    assert.match((await run('validation.reports.manage', { action: 'rename', id: 'missing', name: 'N', expected_reports: '1:0' })).text, /library changed/);
    assert.match((await run('validation.reports.manage', { action: 'rename', id: 'missing', name: 'N', expected_reports: token })).text, /Unknown saved native report/);
  });

  /** Every zones.read row, by following page.next_offset; each page must fit the limit on its own. */
  type ZoneRow = { kind: string; set?: { id: string; zone_count: number }; set_id?: string; zone?: { id: string }; global_id?: number };
  const zoneRows = async () => {
    const rows: ZoneRow[] = []; let offset: number | null = 0, token = '', pages = 0, counts: Record<string, number> = {};
    while (offset !== null) {
      type ZonePage = { rows: ZoneRow[]; configuration_revision: string; counts: Record<string, number>; page: { next_offset: number | null } };
      const value: ZonePage = json<ZonePage>(await run('zones.read', { offset }));
      rows.push(...value.rows); token = value.configuration_revision; counts = value.counts; offset = value.page.next_offset; pages++;
    }
    return { rows, token, pages, counts, of: (kind: string) => rows.filter(row => row.kind === kind) };
  };

  it('#4 #37 library reads page each entry with its save state when the save states alone pass 1 MB', async (t: TestContext) => {
    t.mock.method(clashGroupLibrary, 'initialize', async () => true);
    const ids = Array.from({ length: 5000 }, (_, i) => `${String(i).padStart(6, '0')}${'k'.repeat(194)}`);
    // A failed deletion leaves a save state whose entry is gone; it must stay visible by id.
    const status = { phase: 'ready' as const, recovered: false, items: { ...Object.fromEntries(ids.map(id => [id, 'saved'])), 'deleted-but-stuck': 'conflict' } };
    assert.ok(bytes(status.items) > MAX_RESULT_BYTES, 'the save states alone exceed the limit');
    useClashGroupLibrary.setState({ entries: ids.map(id => ({ version: 1, id, name: 'W', groups: [] })) as never, status: status as never });
    useViewerStore.setState({ savedClashReports: ids.map(id => ({ id, name: 'R' })) as never, savedClashReportsStorage: status as never, initializeSavedClashReports: async () => true,
      savedValidationReports: ids.map(id => ({ id, name: 'V' })) as never, validationReportsStorage: status as never, initializeValidationReports: async () => true });
    for (const [operation, field, storageField] of [['clash.groups.read', 'entries', 'status'], ['clash.reports.read', 'reports', 'storage'], ['validation.reports.read', 'reports', 'storage']] as const) {
      const seen: string[] = [], saved: string[] = []; let offset: number | null = 0, counts: Record<string, number> = {};
      while (offset !== null) {
        type LibraryPage = Record<string, unknown> & { next_offset: number | null };
        const value: LibraryPage = json<LibraryPage>(await run(operation, { offset }));
        seen.push(...(value[field] as Array<{ id: string }>).map(row => row.id));
        const storage = value[storageField] as { items: Record<string, string>; counts: Record<string, number> };
        saved.push(...Object.keys(storage.items)); counts = storage.counts; offset = value.next_offset;
      }
      assert.deepEqual(seen, ids, `${operation}: every entry once, in order`);
      // storage.items is a map, so its key order is not the entry order.
      assert.deepEqual([...saved].sort(), [...ids, 'deleted-but-stuck'].sort(), `${operation}: every save state once, including one whose entry is gone`);
      assert.deepEqual(counts, { saved: 5000, conflict: 1 }, `${operation}: the summary counts every save state`);
    }
  });

  it('#29 zones.read pages assignments over 1 MB and returns one short configuration_revision', async () => {
    const setId = useViewerStore.getState().createZoneSet('Large');
    const record = { [setId]: { zoneId: null, zoneName: pad(60), straddles: false, touchedZoneIds: [] } };
    useViewerStore.setState({ zoneAssignments: new Map(Array.from({ length: 12000 }, (_, i) => [i + 1, record])) });
    const { of, token } = await zoneRows();
    assert.deepEqual(of('assignment').map(row => row.global_id), Array.from({ length: 12000 }, (_, i) => i + 1), 'every assignment once, in order'); assert.ok(token.length <= 64);
    const made = json<{ set_id: string; configuration_revision: string }>(await run('zones.set.create', { name: 'Next', expected_configuration: token }));
    assert.match((await run('zones.set.create', { name: 'Again', expected_configuration: token })).text, /configuration changed/);
    // The edit hands back the revision the next edit needs.
    assert.ok(json<{ set_id: string }>(await run('zones.set.create', { name: 'Again', expected_configuration: made.configuration_revision })).set_id);
  });

  it('#29 zones.read pages a sets list over 1 MB and every page carries configuration_revision', async () => {
    for (let i = 0; i < 300; i++) useViewerStore.getState().createZoneSet(`Set ${i} ${pad(4000)}`);
    assert.ok(bytes(useViewerStore.getState().zoneSets) > MAX_RESULT_BYTES, 'the sets alone exceed the limit');
    const { of, token } = await zoneRows();
    assert.deepEqual(of('set').map(row => row.set!.id), useViewerStore.getState().zoneSets.map(row => row.id)); assert.ok(token.length <= 64);
    const made = json<{ set_id: string; configuration_revision: string }>(await run('zones.set.create', { name: 'Next', expected_configuration: token }));
    // An edit's own result stays small however large the configuration is, so a committed edit never reports failure.
    const renamed = json<{ configuration_revision: string }>(await run('zones.set.edit', { set_id: made.set_id, action: 'rename', name: 'Renamed', visible: true, expected_configuration: made.configuration_revision }));
    assert.equal(useViewerStore.getState().zoneSets.at(-1)!.name, 'Renamed'); assert.ok(renamed.configuration_revision.length <= 64);
  });

  it('#29 zones.read reads one set over 1 MB, its apportionment rows and assignments without dropping or repeating a row', async () => {
    const setId = useViewerStore.getState().createZoneSet('Big');
    for (let i = 0; i < 250; i++) useViewerStore.getState().addZone(setId, { name: `Zone ${i} ${pad(4000)}`, center: [i, 1, 0], size: [1, 1, 1], rotationY: 0 });
    const set = useViewerStore.getState().zoneSets[0];
    assert.ok(bytes(set) > MAX_RESULT_BYTES, 'one set alone exceeds the limit');
    const share = { wholeVolumeM3: 1, shares: [{ zoneId: set.zones[0].id, zoneName: 'A', volumeM3: 1, fraction: 1 }], outsideVolumeM3: 0, outsideFraction: 0 };
    const byElement = new Map(Array.from({ length: 8000 }, (_, i) => [i + 1, share])), refused = new Map(Array.from({ length: 8000 }, (_, i) => [i + 10_001, 'no-geometry']));
    const record = { [setId]: { zoneId: null, zoneName: pad(60), straddles: false, touchedZoneIds: [] } };
    useViewerStore.setState({ zoneApportionment: new Map([[setId, { revision: 'r', byElement, refused, computedAt: 0, elapsedMs: 0 }]]) as never,
      zoneAssignments: new Map(Array.from({ length: 6000 }, (_, i) => [i + 1, record])) });
    const { of, pages, counts } = await zoneRows();
    assert.ok(pages >= 3, `${pages} pages`);
    assert.deepEqual(of('set').map(row => row.set!.id), [setId]); assert.equal(of('set')[0].set!.zone_count, 250);
    assert.deepEqual(of('zone').map(row => row.zone!.id), set.zones.map(zone => zone.id));
    // The seeded entry's revision is not this set's, as after an edit following the run.
    assert.deepEqual(of('apportionment').map(row => (row as { stale?: boolean }).stale), [true]);
    assert.deepEqual(of('apportioned').map(row => row.global_id), [...byElement.keys()]);
    assert.deepEqual(of('refused').map(row => row.global_id), [...refused.keys()]);
    assert.deepEqual(of('assignment').map(row => row.global_id), Array.from({ length: 6000 }, (_, i) => i + 1));
    assert.deepEqual(counts, { set: 1, zone: 250, apportionment: 1, apportioned: 8000, refused: 8000, assignment: 6000 });
  });

  it('#29 every zones.* write returns a small receipt and the next revision when the configuration is over 1 MB', async () => {
    await seedAuthoringSample(); host = viewerHost();
    // zones.generateStoreys reads storeys from the sample and footprint bounds from the renderer's scene.
    setGlobalRendererRef({ current: { getScene: () => ({ getBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } }), getMeshDataPieces: () => [] }) } } as never);
    try {
      useViewerStore.getState().createZoneSet('Imported'); const imported = useViewerStore.getState().exportZoneSetsJSON();
      // The written set alone is over 1 MB, so a write that echoed it would fail after committing.
      const set_id = useViewerStore.getState().createZoneSet('Target');
      for (let i = 0; i < 250; i++) useViewerStore.getState().addZone(set_id, { name: `Zone ${i} ${pad(4000)}`, center: [i, 1, 0], size: [1, 1, 1], rotationY: 0 });
      assert.ok(bytes(useViewerStore.getState().zoneSets.find(row => row.id === set_id)) > MAX_RESULT_BYTES, 'the target set exceeds the limit');
      let revision = json<{ configuration_revision: string }>(await run('zones.read')).configuration_revision;
      const write = async <T,>(operation: string, input: Record<string, unknown>): Promise<T> => {
        const result = await run(operation, { ...input, expected_configuration: revision });
        assert.equal(result.isError, false, `${operation}: ${result.text}`); assert.ok(bytes(result.structured) < 4096, `${operation} returned ${bytes(result.structured)} bytes`);
        const value = json<T & { configuration_revision: string }>(result); revision = value.configuration_revision; return value;
      };
      await write('zones.set.edit', { set_id, action: 'rename', name: 'Renamed', visible: true });
      const { zone_id } = await write<{ zone_id: string }>('zones.box.write', { set_id, zone_id: '', name: 'Box', center: [0, 1, 0], size: [2, 2, 2], rotationY: 0 });
      await write('zones.box.write', { set_id, zone_id, name: 'Moved', center: [1, 1, 1], size: [2, 2, 2], rotationY: 0 });
      await write('zones.box.remove', { set_id, zone_id });
      // The receipts point at zones.read, and it can read this set back; zones.apportion on it stays small too.
      assert.deepEqual((await zoneRows()).of('zone').filter(row => row.set_id === set_id).map(row => row.zone!.id),
        useViewerStore.getState().zoneSets.find(row => row.id === set_id)!.zones.map(zone => zone.id), 'every zone of the set once, in order');
      const apportioned = await run('zones.apportion', { set_id });
      assert.equal(apportioned.isError, false, apportioned.text); assert.ok(bytes(apportioned.structured) < 4096, `zones.apportion returned ${bytes(apportioned.structured)} bytes`);
      await write('zones.set.create', { name: 'Another' });
      assert.ok((await write<{ zone_count: number }>('zones.generateStoreys', { set_id })).zone_count > 0);
      await write('zones.import', { json: imported });
    } finally { setGlobalRendererRef({ current: null } as never); }
  });

  it('#29 zones.apportion returns counts when the per-element rows pass 1 MB', async () => {
    const { walls } = await assemblyOf(60_000);
    setGlobalRendererRef({ current: { getScene: () => ({ getBounds: () => null, getMeshDataPieces: () => [] }) } } as never);
    try {
      const setId = useViewerStore.getState().createZoneSet('Straddled');
      const a = useViewerStore.getState().addZone(setId, { name: 'A', center: [0, 0, 0], size: [1, 1, 1], rotationY: 0 })!, b = useViewerStore.getState().addZone(setId, { name: 'B', center: [1, 0, 0], size: [1, 1, 1], rotationY: 0 })!;
      useViewerStore.setState({ zoneAssignments: new Map(walls.map(id => [id, { [setId]: { zoneId: a, zoneName: 'A', straddles: true, touchedZoneIds: [a, b] } }])) });
      const result = json<{ refused_count: number; refusals: Record<string, number> }>(await run('zones.apportion', { set_id: setId }));
      const stored = useViewerStore.getState().zoneApportionment.get(setId)!;
      assert.ok(bytes([...stored.refused]) + bytes([...stored.byElement]) > MAX_RESULT_BYTES, 'the stored rows exceed the limit');
      assert.equal(result.refused_count, stored.refused.size); assert.equal(Object.values(result.refusals).reduce((sum, n) => sum + n, 0), stored.refused.size);
    } finally { setGlobalRendererRef({ current: null } as never); }
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

  // Seeds are always locked, so any prepare above the member cap also passes the preview-size limit; the export call
  // has no preview check, so it is where the member cap alone decides.
  const reason = (result: AgentToolResult) => (result.structured as { reason?: string } | null)?.reason;
  it('#74 exports.anonymized refuses a membership above the 100k id cap with reason member-cap', async () => {
    await assemblyOf(100_001);
    const result = await run('exports.anonymized', { ...anon, expected_included_ids: [] });
    assert.equal(result.isError, true, result.text.slice(0, 200)); assert.equal(reason(result), 'member-cap', result.text.slice(0, 200)); assert.match(result.text, /Narrow the selection/);
    assert.equal(reason(await run('exports.anonymized.prepare', anon)), 'member-cap', 'the cap is checked before the preview is built');
  });

  it('#74 exports.anonymized.prepare refuses a preview over the result limit below the cap with reason preview-size', async () => {
    // 99,990 members stay under the cap, while the included, locked and group ids together pass 1 MB.
    await assemblyOf(99_990);
    const result = await run('exports.anonymized.prepare', anon);
    assert.equal(result.isError, true, `${bytes(result.structured)}-byte preview was returned: the fixture no longer passes 1 MB`); assert.equal(reason(result), 'preview-size', result.text.slice(0, 200));
    assert.ok((result.structured as { bytes: number }).bytes > MAX_RESULT_BYTES, 'the refused preview really was over the limit'); assert.match(result.text, /Narrow the selection/);
  });
});
