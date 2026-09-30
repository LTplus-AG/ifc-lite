/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #6232 / #6539: uniqueness observes every live IfcRoot while repeated
 * explicit placement never reparses unrelated geometry records. */
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addHostedElementInStore } from './hosted-element.js';
import { AnchorEntityReader } from './resolve-anchor.js';

const GUID = '0000000000000000000001';
async function session(extraPoints = 0) {
  let source = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url), 'utf8');
  const points = Array.from({ length: extraPoints }, (_, i) => `#${900000 + i}=IFCCARTESIANPOINT((${i}.,0.,0.));`).join('\n');
  source = source.replace(/ENDSEC;\s*END-ISO-10303-21;/, `${points}\nENDSEC;\nEND-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}
const place = (s: Awaited<ReturnType<typeof session>>, GlobalId: string, Offset = 8) =>
  addHostedElementInStore(s.store, s.editor, 1222, { kind: 'door', params: { Offset, Width: 0.9, Height: 2.1, GlobalId } });
afterEach(() => vi.restoreAllMocks());

describe('#6539 hosted GlobalId uniqueness', () => {
  it('does not decode unrelated source geometry on explicit placements', async () => {
    const s = await session(100);
    const extraction = vi.spyOn(EntityExtractor.prototype, 'extractEntity');
    place(s, GUID);
    const firstCalls = extraction.mock.calls.length;
    place(s, '0000000000000000000002', 9);
    expect(extraction.mock.calls.filter(([ref]) => ref.expressId >= 900000)).toHaveLength(0);
    // A second placement consults the cached source ownership and live overlay,
    // not another pass over all source IfcRoot records.
    expect(extraction.mock.calls.length - firstCalls).toBeLessThan(firstCalls);
  });

  for (const positional of [false, true]) {
    it(`refuses a source GlobalId changed by a live ${positional ? 'positional' : 'named'} override without history`, async () => {
      const s = await session();
      if (positional) s.view.setPositionalAttribute(1222, 0, GUID, true);
      else s.view.setAttribute(1222, 'GlobalId', GUID, undefined, true);
      const before = s.view.getMutations();
      expect(() => place(s, GUID)).toThrow(/already used by #1222/);
      expect(s.view.getMutations()).toEqual(before);
      expect(s.view.getNewEntities()).toEqual([]);
    });
  }

  it('protects a relationship GlobalId omitted from the display table index', async () => {
    const s = await session();
    const reader = new AnchorEntityReader(s.store, s.view);
    const rel = [...reader.ids('IFCRELVOIDSELEMENT')][0];
    const guid = reader.entity(rel)!.attributes[0];
    expect(typeof guid).toBe('string');
    if (typeof guid !== 'string') throw new Error('The Bonsai void relationship must have a GlobalId');
    expect(s.store.entities.getExpressIdByGlobalId(guid)).toBe(-1);
    expect(() => place(s, guid)).toThrow(new RegExp(`already used by #${rel}`));
    expect(s.view.getNewEntities()).toEqual([]);
  });

  it('allows reuse after a source owner is renamed, but still checks new owners', async () => {
    const s = await session();
    const guid = new AnchorEntityReader(s.store, s.view).entity(1222)!.attributes[0];
    if (typeof guid !== 'string') throw new Error('The Bonsai wall must have a GlobalId');
    s.editor.setAttribute(1222, 'GlobalId', GUID);
    const door = place(s, guid);
    expect(s.view.getNewEntity(door.expressId)!.attributes[0]).toBe(guid);
    expect(() => place(s, guid, 9)).toThrow(new RegExp(`already used by #${door.expressId}`));
  });

  it('allows a forgotten created owner and rejects its restored record', async () => {
    const s = await session();
    const created = s.editor.addEntity('IfcWall', [GUID, null, 'Temporary owner']);
    const record = s.view.getNewEntity(created.expressId)!;
    s.editor.removeEntity(created.expressId);
    const door = place(s, GUID);
    s.editor.removeEntity(door.expressId);
    s.editor.removeEntity(door.openingId);
    s.view.restoreNewEntity(record);
    expect(() => place(s, GUID, 9)).toThrow(new RegExp(`already used by #${created.expressId}`));
  });
});
