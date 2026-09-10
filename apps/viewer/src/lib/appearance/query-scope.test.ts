/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { Rule } from '../search/filter-rules.js';
import { saveFilter, loadSavedFilters, clearSavedFilters, __internal } from '../search/saved-filters.js';
import { captureAppearanceSource } from './command.js';
import { ownAppearanceQuery } from './query-definition.js';
import { resolveAppearanceScope } from './query-scope.js';
import type { AppearanceSnapshot } from './snapshot.js';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); clearSavedFilters(); });
const signal = () => new AbortController().signal;
const scope = (rules = [Rule.name('eq', 'Chosen')]) => ({ kind: 'filter' as const,
  query: ownAppearanceQuery({ name: 'Chosen surfaces', combinator: 'AND', rules }) });
async function fixture(count = 2) {
  const ids = Array.from({ length: count }, (_, index) => index + 10);
  const source = new TextEncoder().encode(`ISO-10303-21;HEADER;
FILE_DESCRIPTION(('Query membership invariant'),'2;1');FILE_NAME('query.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
${ids.map(id => `#${id}=IFCWALL('${String(id).padStart(22, '0')}',$,'Chosen',$,$,$,$,$,.NOTDEFINED.);`).join('\n')}
ENDSEC;END-ISO-10303-21;`);
  const data = await new IfcParser().parseColumnar(source.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(data.properties, 'query');
  const editor = new StoreEditor(data, view);
  const model = { ...fixtureModel('query'), ifcDataStore: data, sourceFingerprint: 'query:fingerprint', schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ models: new Map([['query', model], ['other', { ...model, id: 'other', sourceFingerprint: 'other:fingerprint' }]]),
    mutationViews: new Map([['query', view]]), mutationVersion: 0 });
  async function snapshot(): Promise<AppearanceSnapshot> {
    const exported = await new StepExporter(data, view).exportAsync({ schema: 'IFC4', applyMutations: true, includeGeometry: true });
    const guard = captureAppearanceSource(view);
    return { modelId: 'query', revision: 'test', schema: 'IFC4', nextExpressId: view.peekNextExpressId(),
      bytes: typeof exported.content === 'string' ? new TextEncoder().encode(exported.content) : exported.content,
      productIds: ids, catalog: { sourceRevision: 'test', products: [], types: [], missingProductIds: [] }, source: guard,
      validate() { guard.validate(view); } };
  }
  return { snapshot, editor, view, ids };
}
it('queries effective IFC edits and invalidates the captured membership after an SDK write (#4404)', async () => {
  const f = await fixture();
  f.editor.setAttribute(10, 'Name', 'Other');
  const before = await f.snapshot();
  assert.deepEqual((await resolveAppearanceScope(before, [], scope(), signal())).productIds, [11]);
  f.editor.setAttribute(11, 'Name', 'Other');
  assert.equal(useViewerStore.getState().mutationVersion, 0);
  await assert.rejects(resolveAppearanceScope(before, [], scope(), signal()), /overlay changed/);
  assert.deepEqual((await resolveAppearanceScope(await f.snapshot(), [], scope(), signal())).productIds, []);
});
it('evaluates all bounded candidates without Search result truncation or federated ID mixing (#4404)', async () => {
  const f = await fixture(5001), snapshot = await f.snapshot();
  assert.deepEqual((await resolveAppearanceScope(snapshot, [], scope(), signal())).productIds, f.ids);
  const query = { kind: 'filter' as const, query: ownAppearanceQuery({ name: 'Other model', combinator: 'AND', rules: [Rule.model(['other:fingerprint'])] }) };
  assert.deepEqual((await resolveAppearanceScope(snapshot, [], query, signal())).productIds, []);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(resolveAppearanceScope(snapshot, [], scope(), abort.signal), { name: 'AbortError' });
});
it('never broadens a saved AND query by dropping malformed predicates and owns its copied definition (#4404)', () => {
  saveFilter('Chosen', 'AND', [Rule.name('eq', 'Chosen')]);
  const captured = ownAppearanceQuery(loadSavedFilters(ownAppearanceQuery)[0]);
  saveFilter('Chosen', 'AND', [Rule.name('ne', 'Impossible')]);
  assert.deepEqual(captured.rules, [Rule.name('eq', 'Chosen')]);
  for (const invalid of [{ kind: 'unknown' }, { kind: 'name', op: 'invalid', value: 'x' }, Rule.name('notMatches', '['),
    Rule.storey(['Level'], 'in', [{ modelId: 'old-session', expressId: 10 }])]) {
    assert.throws(() => ownAppearanceQuery({ name: 'Bad', combinator: 'AND', rules: [Rule.ifcType(['IfcWall']), invalid] }));
  }
  localStorage.setItem(__internal.STORAGE_KEY, JSON.stringify([{ name: 'Corrupt AND', combinator: 'AND',
    rules: [Rule.ifcType(['IfcWall']), { kind: 'unknown' }] }]));
  const warn = console.warn; console.warn = () => {};
  try { assert.deepEqual(loadSavedFilters(ownAppearanceQuery), []); }
  finally { console.warn = warn; }
  assert.ok(localStorage.getItem(__internal.STORAGE_KEY)?.includes('unknown'), 'Rejected original preset is preserved');
});
