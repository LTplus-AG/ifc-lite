/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { extractProjectUnits, extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { contextFor, quantitySetsFor } from '@/hooks/zoneFacts';
import type { ZoneVolumeShare } from './apportionment';
import { buildZoneTable, exportZoneTable } from '@/hooks/useZoneTableExport';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { cleanup, render } from '@/test/render';
import { inheritedSource, parse } from '@/test/inherited-quantities-native-fixture';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });

async function explicitFixture(t: TestContext, occurrence: boolean) {
  const x = await inheritedSource(t); if (!x) return;
  const editor = new StoreEditor(x.store, x.view);
  const unit = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']).expressId;
  x.view.setPositionalAttribute(x.a.volume, 2, `#${unit}`);
  let quantityId = x.a.volume;
  if (occurrence) {
    // The occurrence wins over both the later own basis and inherited Net30.
    x.view.setPositionalAttribute(x.a.volume, 3, 30);
    const ownerId = x.store.getEntity(x.f.id)?.attributes[1];
    const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
    const volume = (name: string, value: number, explicit: boolean) => editor.addEntity('IfcQuantityVolume',
      x.store.schemaVersion === 'IFC2X3' ? [name, null, explicit ? `#${unit}` : null, value]
        : [name, null, explicit ? `#${unit}` : null, value, null]).expressId;
    quantityId = volume('NetExplicitVolume', 10, true);
    const later = volume('NetLaterVolume', 999, true);
    const gross = volume('GrossImplicitVolume', 99, false);
    const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Qto_ExplicitOccurrence', null, null,
      [`#${quantityId}`, `#${later}`, `#${gross}`]]).expressId;
    editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${x.f.id}`], `#${qto}`]);
  }
  const store = await parse(editedModelBytes(x.store, x.view));
  assert.equal(store.getEntity(quantityId)?.attributes[2], unit, 'real native export/reparse preserves member Unit');
  assert.equal(store.getEntity(quantityId)?.attributes[3], 10, 'real native export/reparse preserves raw amount');
  assert.deepEqual(store.getEntity(unit)?.attributes.slice(1), ['.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']);
  const native = (occurrence ? extractQuantitiesOnDemand(store, x.f.id) : extractTypeQuantitiesOnDemand(store, x.f.id)?.quantities ?? [])
    .flatMap(set => set.quantities).find(q => q.name === (occurrence ? 'NetExplicitVolume' : 'NetVolume'));
  assert.ok(native);
  assert.equal(native.explicitUnitSiScale, 1e-9, 'canonical native collector independently resolves cubic millimetres');
  assert.equal(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1,
    'actual project cubic metres differ from the explicit member unit');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store,
    maxExpressId: getMaxExpressId(store, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: store,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  return { ...x, store, view, unit, quantityId, quantityName: native.name };
}

test('#7376 unavailable current project context keeps explicitly resolvable native volume but withholds implicit table magnitude', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  // @raw-entity-enumeration-ok fixture identifies the original native Project before unsetting its current assignment.
  const project = x.store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  x.view.setPositionalAttribute(project, 8, null);
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.equal(exported.getEntity(project)?.attributes[8], null, 'independent native export contains unavailable UnitsInContext');
  assert.equal(exported.getEntity(x.quantityId)?.attributes[2], x.unit);
  const explicit = extractQuantitiesOnDemand(exported, x.f.id).flatMap(set => set.quantities).find(q => q.name === x.quantityName);
  assert.equal(explicit?.explicitUnitSiScale, 1e-9, 'explicit member remains independently resolved');
  const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
  const context = contextFor('arch', new Map()); assert.ok(context);
  const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantitySetsFor(context, x.f.id)}
    projectUnits={extractProjectUnits(exported.source, exported.entityIndex)} unitDisplayOverrides={{ VOLUMEUNIT: 'cm3' }}
    quantityUnitCoverage={{ status: 'unavailable', reason: 'Native UnitsInContext was unset' }} />);
  const label = [...panel.querySelectorAll('span')].find(span => span.textContent === x.quantityName); assert.ok(label);
  assert.match(label.parentElement?.textContent ?? '', /0[.,]01\s*cm³/);
  assert.doesNotMatch(panel.textContent ?? '', /GrossImplicitVolume/, 'unknown implicit basis cannot become a default SI magnitude');
  const net = buildZoneTable(x.f.zoneSet, 'net'), gross = buildZoneTable(x.f.zoneSet, 'gross');
  assert.equal(net.length, 2); assert.equal(gross.length, 2);
  for (const row of net) assert.ok(row.ElementVolumeM3 !== null && Math.abs(row.ElementVolumeM3 - 1e-8) < 1e-20);
  for (const row of gross) {
    assert.equal(row.VolumeM3, null); assert.equal(row.ElementVolumeM3, null);
    assert.ok(row.Unavailable.length > 0, 'CSV/table refusal stays explicit instead of claiming99 m³');
  }
  assert.equal(x.view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
});

test('#7376 unsupported native explicit member unit cannot fall back to project cubic metres in mounted card/table', async t => {
  const x = await explicitFixture(t, false); if (!x) return;
  x.view.setPositionalAttribute(x.unit, 1, '.LENGTHUNIT.');
  x.view.setPositionalAttribute(x.unit, 3, '.METRE.');
  const exported = await parse(editedModelBytes(x.store, x.view));
  assert.deepEqual(exported.getEntity(x.unit)?.attributes.slice(1), ['.LENGTHUNIT.', '.MILLI.', '.METRE.'],
    'native export proves a dimensionally unsupported explicit Unit, not an omitted implicit Unit');
  const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
  const context = contextFor('arch', new Map()); assert.ok(context);
  const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantitySetsFor(context, x.f.id)}
    projectUnits={extractProjectUnits(x.store.source, x.store.entityIndex)} unitDisplayOverrides={{}} />);
  assert.ok(![...panel.querySelectorAll('span')].some(span => span.textContent === x.quantityName),
    'unsupported explicit member cannot produce a physical NetVolume basis');
  const rows = buildZoneTable(x.f.zoneSet, 'net'); assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.VolumeM3, null); assert.match(row.Unavailable, /inherited native quantities are unavailable/); assert.doesNotMatch(row.Unavailable, /declares no/); }
  const mesh = buildZoneTable(x.f.zoneSet, 'mesh');
  for (const row of mesh) assert.ok(row.ElementVolumeM3 !== null && Math.abs(row.ElementVolumeM3 - x.f.apportionment.wholeVolumeM3)
    <= Math.max(1e-12, x.f.apportionment.wholeVolumeM3 * 1e-12));
  assert.equal(x.view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
});

test('#7376 unsupported first occurrence volume unit refuses the basis instead of falling through to later own or valid inherited quantity', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  const wrong = new StoreEditor(x.store, x.view).addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
  x.view.setPositionalAttribute(x.quantityId, 2, `#${wrong}`);
  // Deliberately author/reparse a new source before reading. This is not a
  // claim that the separate live own-quantity Unit cache defect (#7379) is fixed.
  const source = await parse(editedModelBytes(x.store, x.view));
  assert.equal(source.getEntity(x.quantityId)?.attributes[2], wrong);
  assert.equal(source.getEntity(x.quantityId)?.attributes[3], 10);
  assert.deepEqual(source.getEntity(wrong)?.attributes.slice(1), ['.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  const inherited = extractTypeQuantitiesOnDemand(source, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
  assert.equal(inherited?.value, 30); assert.equal(inherited?.explicitUnitSiScale, 1e-9, 'independent inherited alternative remains genuinely available');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
    maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: source,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  const before = editedModelBytes(source, view), revision = view.getMutationRevision();
  const context = contextFor('arch', new Map()); assert.ok(context);
  const quantities = quantitySetsFor(context, x.f.id);
  assert.deepEqual(quantities.flatMap(set => set.quantities).filter(q => q.name.startsWith('Net')).map(q => q.value), [10, 999, 30],
    'unreadable physical basis is not implemented by dropping the first occurrence');
  const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantities}
    projectUnits={extractProjectUnits(source.source, source.entityIndex)} unitDisplayOverrides={{}} />);
  assert.ok(![...panel.querySelectorAll('span')].some(span => ['NetExplicitVolume', 'NetLaterVolume', 'NetVolume'].includes(span.textContent ?? '')),
    'a refused first native basis does not silently acquire a later magnitude');
  const rows = buildZoneTable(x.f.zoneSet, 'net'); assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.VolumeM3, null); assert.equal(row.ElementVolumeM3, null); assert.match(row.Unavailable, /unit is unavailable/); assert.doesNotMatch(row.Unavailable, /declares no/); }
  assert.equal(view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(source, view), before);
});

/** RFC4180 decoding of actual CSV bytes, including native names with commas. */
function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === ',') { row.push(field); field = ''; }
    else if (!quoted && c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  assert.equal(quoted, false, 'exported CSV has no unterminated quoted field');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function assertTableAndCsv(x: NonNullable<Awaited<ReturnType<typeof explicitFixture>>>, expectedM3: number) {
  const rows = buildZoneTable(x.f.zoneSet, 'net'); assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.Quantity, x.quantityName); assert.equal(row.ExpressId, x.f.id); assert.equal(row.Unavailable, '');
    assert.ok(row.ElementVolumeM3 !== null && Math.abs(row.ElementVolumeM3 - expectedM3) < Math.max(1e-20, expectedM3 * 1e-12));
    const share: ZoneVolumeShare | undefined = x.f.apportionment.shares.find(candidate => candidate.zoneName === row.Zone); assert.ok(share);
    assert.ok(row.VolumeM3 !== null && Math.abs(row.VolumeM3 - share.fraction * expectedM3) < Math.max(1e-20, expectedM3 * 1e-12));
  }
  const downloads: Uint8Array[] = [];
  const result = await exportZoneTable(x.f.zoneSet, 'net', 'csv', bytes => downloads.push(bytes));
  assert.equal(result.unmeasured, 0); assert.equal(downloads.length, 1);
  const [header, ...body] = csvRows(new TextDecoder().decode(downloads[0])); assert.equal(body.length, 2);
  for (const row of body) {
    assert.equal(Number(row[header.indexOf('ExpressId')]), x.f.id); assert.equal(row[header.indexOf('Quantity')], x.quantityName);
    assert.ok(Math.abs(Number(row[header.indexOf('ElementVolumeM3')]) - expectedM3) < Math.max(1e-20, expectedM3 * 1e-12));
    const sourceRow = rows.find(source => source.Zone === row[header.indexOf('Zone')]); assert.ok(sourceRow);
    assert.equal(Number(row[header.indexOf('VolumeM3')]), sourceRow.VolumeM3);
  }
}

for (const remove of [false, true]) {
  test(`#7376 current native Type quantity Unit ${remove ? 'removal' : 'replacement'} reaches mounted card/table/CSV without stale source metadata`, async t => {
    const x = await explicitFixture(t, false); if (!x) return;
    const replacement = remove ? null : new StoreEditor(x.store, x.view)
      .addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
    x.view.setPositionalAttribute(x.quantityId, 2, replacement === null ? null : `#${replacement}`);
    const exported = await parse(editedModelBytes(x.store, x.view));
    assert.equal(exported.getEntity(x.quantityId)?.attributes[2], replacement);
    const native = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === x.quantityName);
    assert.ok(native); assert.equal(native.value, 10);
    if (remove) assert.equal(native.explicitUnitSiScale, undefined);
    else assert.ok(native.explicitUnitSiScale !== undefined && Math.abs(native.explicitUnitSiScale - 1e-6) < 1e-20,
      'canonical centimetre-cubed scaling differs only within floating-point roundoff');
    const expectedM3 = remove ? 10 : 1e-5;
    assert.equal(extractProjectUnits(exported.source, exported.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1);
    const before = editedModelBytes(x.store, x.view), revision = x.view.getMutationRevision();
    const context = contextFor('arch', new Map()); assert.ok(context);
    const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantitySetsFor(context, x.f.id)}
      projectUnits={extractProjectUnits(exported.source, exported.entityIndex)} unitDisplayOverrides={remove ? {} : { VOLUMEUNIT: 'cm3' }} />);
    const label = [...panel.querySelectorAll('span')].find(span => span.textContent === x.quantityName); assert.ok(label);
    assert.match(label.parentElement?.textContent ?? '', remove ? /10\s*m³/ : /10\s*cm³/);
    await assertTableAndCsv(x, expectedM3);
    assert.equal(x.view.getMutationRevision(), revision);
    await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before);
  });
}


for (const occurrence of [true, false]) {
  test(`#7376 native ${occurrence ? 'occurrence first basis' : 'inherited Type'} explicit volume agrees in mounted card, zone table and exported CSV`, async t => {
    const x = await explicitFixture(t, occurrence); if (!x) return;
    const state = useViewerStore.getState(), cache = state.zoneApportionment, geometry = state.models.get('arch')?.geometryResult;
    const cacheEntry = cache.get(x.f.zoneSet.id), revision = x.view.getMutationRevision(), changes = x.view.getEffectiveChanges();
    assert.ok(cacheEntry); assert.equal(cacheEntry.byElement.get(x.f.id), x.f.apportionment, 'actual native apportionment is present before reading');
    const before = editedModelBytes(x.store, x.view);
    const context = contextFor('arch', new Map()); assert.ok(context);
    const quantities = quantitySetsFor(context, x.f.id);
    const net = quantities.flatMap(set => set.quantities).filter(q => q.name.toLowerCase().startsWith('net'));
    assert.equal(net[0]?.name, x.quantityName, 'own-before-inherited and native first basis remain explicit');
    if (occurrence) assert.deepEqual(net.map(q => q.value), [10, 999, 30], 'all competing native bases remain readable, not silently discarded');
    const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantities}
      projectUnits={extractProjectUnits(x.store.source, x.store.entityIndex)} unitDisplayOverrides={{ VOLUMEUNIT: 'cm3' }} />);
    const label = [...panel.querySelectorAll('span')].find(span => span.textContent === x.quantityName); assert.ok(label);
    assert.match(label.parentElement?.textContent ?? '', /0[.,]01\s*cm³/,
      '10 native mm³ displays as 0.01 cm³, not project-unit 10 m³');
    const rows = buildZoneTable(x.f.zoneSet, 'net');
    assert.equal(rows.length, 2, 'real native straddler supplies both measured zone rows');
    for (const row of rows) {
      assert.equal(row.ExpressId, x.f.id); assert.equal(row.Quantity, x.quantityName); assert.equal(row.Unavailable, '');
      assert.ok(row.VolumeM3 !== null && row.Fraction !== null && row.ElementVolumeM3 !== null);
      assert.ok(Math.abs(row.ElementVolumeM3 - 1e-8) < 1e-20, 'member Unit wins over project cubic metres');
      const share: ZoneVolumeShare | undefined = x.f.apportionment.shares.find(candidate => candidate.zoneName === row.Zone); assert.ok(share);
      assert.ok(Math.abs(row.VolumeM3 - share.fraction * 1e-8) < 1e-20, 'native mesh fraction apportions independently known SI amount');
      assert.ok(Math.abs(row.Fraction - share.fraction) < 1e-12);
    }
    const downloads: { bytes: Uint8Array; mime: string }[] = [];
    const result = await exportZoneTable(x.f.zoneSet, 'net', 'csv', (bytes, _filename, mime) => downloads.push({ bytes, mime }));
    assert.equal(result.blocked, null); assert.equal(result.unmeasured, 0); assert.equal(result.elements, 1);
    assert.equal(downloads.length, 1); assert.equal(downloads[0].mime, 'text/csv');
    const [header, ...body] = csvRows(new TextDecoder().decode(downloads[0].bytes));
    assert.equal(body.length, 2);
    for (const row of body) {
      assert.equal(Number(row[header.indexOf('ExpressId')]), x.f.id);
      assert.equal(row[header.indexOf('Quantity')], x.quantityName);
      assert.ok(Math.abs(Number(row[header.indexOf('ElementVolumeM3')]) - 1e-8) < 1e-20);
      const sourceRow = rows.find(source => source.Zone === row[header.indexOf('Zone')]); assert.ok(sourceRow);
      assert.equal(Number(row[header.indexOf('VolumeM3')]), sourceRow.VolumeM3);
      assert.equal(Number(row[header.indexOf('Fraction')]), sourceRow.Fraction);
    }
    const mesh = buildZoneTable(x.f.zoneSet, 'mesh');
    for (const row of mesh) assert.ok(row.ElementVolumeM3 !== null && Math.abs(row.ElementVolumeM3 - x.f.apportionment.wholeVolumeM3)
      <= Math.max(1e-12, x.f.apportionment.wholeVolumeM3 * 1e-12), 'known native mesh SI magnitude does not inherit explicit quantity scaling');
    assert.equal(useViewerStore.getState().zoneApportionment, cache); assert.equal(cache.get(x.f.zoneSet.id), cacheEntry);
    assert.equal(useViewerStore.getState().models.get('arch')?.geometryResult, geometry);
    assert.equal(x.view.getMutationRevision(), revision); assert.deepEqual(x.view.getEffectiveChanges(), changes);
    await assertSameNativeIfcGraph(editedModelBytes(x.store, x.view), before, 'card/table/CSV read leaves every native record unchanged');
  });
}


test('#7376 unavailable project context retains the first implicit occurrence basis instead of promoting a later explicit native quantity', async t => {
  const x = await explicitFixture(t, true); if (!x) return;
  x.view.setPositionalAttribute(x.quantityId, 2, null);
  // Author/reparse the implicit occurrence before reading; this does not claim
  // that live own-quantity Unit metadata edits (#7379) have been implemented.
  const source = await parse(editedModelBytes(x.store, x.view));
  assert.equal(source.getEntity(x.quantityId)?.attributes[2], null);
  assert.equal(source.getEntity(x.quantityId)?.attributes[3], 10);
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
    maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: source,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  // @raw-entity-enumeration-ok fixture identifies the parsed native Project before removing its current assignment.
  const project = source.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  view.setPositionalAttribute(project, 8, null);
  const exported = await parse(editedModelBytes(source, view));
  assert.equal(exported.getEntity(project)?.attributes[8], null);
  const own = extractQuantitiesOnDemand(exported, x.f.id).flatMap(set => set.quantities);
  const first = own.find(q => q.name === 'NetExplicitVolume'); assert.ok(first);
  assert.equal(first.value, 10); assert.equal(first.explicitUnitSiScale, undefined);
  const later = own.find(q => q.name === 'NetLaterVolume'); assert.ok(later);
  assert.equal(later.value, 999); assert.equal(later.explicitUnitSiScale, 1e-9);
  const inherited = extractTypeQuantitiesOnDemand(exported, x.f.id)?.quantities.flatMap(set => set.quantities).find(q => q.name === 'NetVolume');
  assert.equal(inherited?.value, 30); assert.equal(inherited?.explicitUnitSiScale, 1e-9);
  const before = editedModelBytes(source, view), revision = view.getMutationRevision();
  const context = contextFor('arch', new Map()); assert.ok(context);
  const quantities = quantitySetsFor(context, x.f.id);
  assert.deepEqual(quantities.flatMap(set => set.quantities).filter(q => q.name.startsWith('Net')).map(q => q.value), [10, 999, 30],
    'unavailable physical context does not erase native first-basis ownership');
  const panel = render(<ZoneVolumeBreakdown zoneSet={x.f.zoneSet} globalId={x.f.id} quantitySets={quantities}
    projectUnits={extractProjectUnits(exported.source, exported.entityIndex)} unitDisplayOverrides={{}}
    quantityUnitCoverage={{ status: 'unavailable', reason: 'Native UnitsInContext was unset' }} />);
  assert.ok(![...panel.querySelectorAll('span')].some(span => ['NetExplicitVolume', 'NetLaterVolume', 'NetVolume'].includes(span.textContent ?? '')),
    'neither a later own nor inherited explicit amount certifies the unavailable first occurrence basis');
  const rows = buildZoneTable(x.f.zoneSet, 'net'); assert.equal(rows.length, 2);
  for (const row of rows) { assert.equal(row.VolumeM3, null); assert.equal(row.ElementVolumeM3, null); assert.match(row.Unavailable, /unit is unavailable/); assert.doesNotMatch(row.Unavailable, /declares no/); }
  const downloads: Uint8Array[] = [];
  const result = await exportZoneTable(x.f.zoneSet, 'net', 'csv', bytes => downloads.push(bytes));
  assert.equal(result.unmeasured, 2); assert.equal(downloads.length, 1);
  const [header, ...body] = csvRows(new TextDecoder().decode(downloads[0])); assert.equal(body.length, 2);
  for (const row of body) {
    assert.equal(row[header.indexOf('VolumeM3')], ''); assert.equal(row[header.indexOf('ElementVolumeM3')], '');
    assert.ok(row[header.indexOf('Unavailable')].length > 0);
  }
  assert.equal(view.getMutationRevision(), revision);
  await assertSameNativeIfcGraph(editedModelBytes(source, view), before);
});
