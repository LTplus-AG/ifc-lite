import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { IfcParser, extractProjectUnits, extractTypeQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcQuery } from '@ifc-lite/query';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { RelationshipType, QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef(null); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
const net = (sets: readonly { quantities: readonly { name: string; value: number }[] }[]) => sets.flatMap(set => [...set.quantities]).find(q => q.name === 'NetVolume')?.value;
const native = async (store: IfcDataStore, view: MutablePropertyView, id: number) => net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(store, view)), id)?.quantities ?? []);

test('#7353 canonical inherited quantity card follows native edits and type reassignment', async t => {
 const f = await seedDeclaredZoneWall(t); if (!f) return;
 const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
 const editor = new StoreEditor(f.store, draft);
 const ownerId = f.store.getEntity(f.id)?.attributes[1];
 const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
 // Prepare authentic exported source ownership: keep the real wall/geometry but replace its quantity/type assignments.
 for (const kind of ['IFCRELDEFINESBYPROPERTIES', 'IFCRELDEFINESBYTYPE']) {
  for (const id of f.store.entityIndex.byType.get(kind) ?? []) {
   const attrs = f.store.getEntity(id)?.attributes;
   const members = attrs?.[4];
   if (!Array.isArray(members) || !members.includes(f.id)) continue;
   const others = members.filter(id => id !== f.id);
   if (others.length) draft.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else draft.deleteEntity(id);
  }
 }
 const makeType = (value: number, name: string) => {
  const volume = editor.addEntity('IfcQuantityVolume', f.store.schemaVersion === 'IFC2X3' ? ['NetVolume', null, null, value] : ['NetVolume', null, null, value, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Qto_WallBaseQuantities', null, null, [`#${volume}`]]).expressId;
  const type = editor.addEntity('IfcWallType', [generateIfcGuid(), owner, name, null, null, [`#${qto}`], null, null, null, '.NOTDEFINED.']).expressId;
  return { volume, type };
 };
 const a = makeType(10, 'Native quantity type A'), b = makeType(30, 'Native quantity type B');
 const relation = editor.addEntity('IfcRelDefinesByType', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${a.type}`]).expressId;
 const store = await parse(editedModelBytes(f.store, draft));
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10);
 const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
 useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store }]]), ifcDataStore: store, mutationViews: new Map(), storeEditors: new Map() });
 const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
 const read = () => {
  const own = effectiveElementData(f.id, new IfcQuery(store), view).qsets;
  assert.equal(own.length, 0, 'source preparation leaves type-only quantities');
  const canonical = withInheritedTypeQuantities(own, store, f.id, RelationshipType.DefinesByType, (s, id) => extractTypeQuantitiesOnDemand(s as IfcDataStore, id, view)?.quantities);
  return { canonical };
 };
 assert.equal(net(read().canonical), 10);
 view.setPositionalAttribute(a.volume, 3, 20);
 assert.equal(await native(store, view, f.id), 20, 'independent export/reparse sees current type quantity edit');
 let result = read();
 const editedQuantity = net(result.canonical);
 const ui = render(<ZoneVolumeBreakdown zoneSet={f.zoneSet} globalId={f.id} quantitySets={result.canonical} projectUnits={extractProjectUnits(store.source, store.entityIndex)} unitDisplayOverrides={{}} />);
 assert.ok(ui.textContent?.includes('net'), 'mount actual native Properties card on its canonical quantity input');
 console.log('NATIVE_TYPE_QUANTITY_EDIT', JSON.stringify({ native: 20, canonicalCardInput: net(result.canonical), cardText: ui.textContent })); cleanup();
 const panel = render(<PropertiesPanel />);
 assert.match(panel.textContent ?? '', /netNetVolume20 m³/, 'actual Properties panel passes the current native view to its inherited quantity card');
 cleanup();
 view.setPositionalAttribute(relation, 5, `#${b.type}`);
 assert.equal(await native(store, view, f.id), 30, 'independent export/reparse follows the new native type');
 result = read(); const reassignedQuantity = net(result.canonical);
 assert.deepEqual({ editedQuantity, reassignedQuantity }, { editedQuantity: 20, reassignedQuantity: 30 }, 'canonical card must agree with both independently reparsed native exports');
 console.log('TYPE_REASSIGN', JSON.stringify({ native: 30, canonicalCardInput: net(result.canonical) }));
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only API retains the original native snapshot');
 const journalBefore = editedModelBytes(store, view);
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT + '.before.ifc', journalBefore);
 const revision = view.getMutationRevision();
 const beforeRead = useViewerStore.getState().mutationVersion;
 view.setQuantity(b.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, undefined, true);
 assert.ok(view.getMutationRevision() > revision);
 assert.equal(useViewerStore.getState().mutationVersion, beforeRead, 'direct native edits need not publish a viewer notification');
 const journalExport = editedModelBytes(store, view);
 const journalStore = await parse(journalExport);
 const nativeSets = extractTypeQuantitiesOnDemand(journalStore, f.id)?.quantities ?? [];
 console.log('NATIVE_TYPE_JOURNAL_INVENTORY', JSON.stringify(nativeSets));
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT, journalExport);
 await assertSameNativeIfcGraph(journalExport, journalBefore, 'the current native writer ignores this type-owned quantity journal write (#7355 counterexample)');
 assert.equal(net(nativeSets), 30, 'native HasPropertySets remains first after a type quantity journal write');
 const source = store.source.materialize().slice();
 const readRevision = view.getMutationRevision();
 const readJournal = view.getMutations();
 assert.equal(net(read().canonical), 30, 'canonical reader must retain independently reparsed native basis precedence');
 assert.equal(view.getMutationRevision(), readRevision, 'current extraction remains read-only');
 assert.deepEqual(view.getMutations(), readJournal, 'current extraction preserves native journal');
 assert.deepEqual(store.source.materialize(), source, 'current extraction preserves source bytes');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const deletedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(deletedView);
 deletedView.deleteEntity(a.volume);
 assert.equal(await native(store, deletedView, f.id), undefined, 'native export drops an empty type quantity set');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, deletedView)?.quantities ?? []), undefined, 'deleted native quantities cannot be resurrected');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const detachedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(detachedView);
 detachedView.deleteEntity(relation);
 assert.equal(await native(store, detachedView, f.id), undefined, 'native export has no type after relationship deletion');
 assert.equal(extractTypeQuantitiesOnDemand(store, f.id, detachedView), null, 'deleted type assignments cannot be resurrected');
 const independentView = new MutablePropertyView(store.properties);
 independentView.setAttribute(a.volume, 'VolumeValue', '70');
 assert.equal(await native(store, independentView, f.id), 70, 'independent native model view exports its named edit');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 70, 'shared source does not share another view quantity cache');
 independentView.setPositionalAttribute(a.volume, 3, 80);
 assert.equal(await native(store, independentView, f.id), 80);
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 80, 'positional precedence and direct revision invalidate the memo');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, view)?.quantities ?? []), 30, 'the original model view retains its current native basis');



});

