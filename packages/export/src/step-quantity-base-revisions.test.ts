/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A set a view's quantity base revises for a LOADED element (a refreshed
 * `Qto_*` after a geometry edit, #9026 item 20 follow-up) has no edit behind
 * it, so the exporter writes it only because the view names it
 * (`MutablePropertyView.setQuantityBaseRevisions`).
 */

import { describe, expect, it } from 'vitest';
import { QuantityType, type QuantitySet } from '@ifc-lite/data';
import { IfcParser, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const WALL = 8;
const SET = 'Qto_WallBaseQuantities';
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition[DesignTransferView]'),'2;1');
FILE_NAME('loaded.ifc','2026-11-07T10:00:00+01:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0OSuGGYUFyIf0LtE29OSuG',$,'My Project',$,$,$,$,$,$);
#8=IFCWALL('0OSuGGYUFyIf0LtE29OSuH',$,'Loaded Wall',$,$,$,$,$,$);
#60=IFCELEMENTQUANTITY('0OSuGGYUFyIf0LtE29OSuV',$,'${SET}',$,$,(#61,#62));
#61=IFCQUANTITYLENGTH('Height',$,$,3.,$);
#62=IFCQUANTITYVOLUME('GrossVolume',$,$,4.8,$);
#63=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuW',$,$,$,(#8),#60);
#70=IFCELEMENTQUANTITY('0OSuGGYUFyIf0LtE29OSuX',$,'Qto_Custom',$,$,(#71));
#71=IFCQUANTITYCOUNT('Fixings',$,$,4.,$);
#72=IFCRELDEFINESBYPROPERTIES('0OSuGGYUFyIf0LtE29OSuY',$,$,$,(#8),#70);
ENDSEC;
END-ISO-10303-21;`;

const parse = (text: string): Promise<IfcDataStore> => {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};

interface Fixture { store: IfcDataStore; view: MutablePropertyView; refresh: { on: boolean } }

/** A view whose base refreshes the wall's set from "geometry" while `refresh.on`, the way the viewer's does. */
async function fixture(): Promise<Fixture> {
  const store = await parse(IFC);
  const view = new MutablePropertyView(null, 'm');
  const refresh = { on: true };
  const refreshed = (own: QuantitySet[]): QuantitySet[] => own.map((set) => (set.name === SET
    ? { ...set, quantities: [{ name: 'Height', type: QuantityType.Length, value: 4 }, { name: 'GrossVolume', type: QuantityType.Volume, value: 6.4 }] }
    : set));
  view.setQuantityExtractor((id) => {
    const own = extractQuantitiesOnDemand(store, id);
    return refresh.on && id === WALL ? refreshed(own) : own;
  });
  view.setQuantityBaseRevisions(() => (refresh.on ? [{ entityId: WALL, setName: SET }] : []));
  return { store, view, refresh };
}

const exported = (f: Fixture, options: Parameters<StepExporter['export']>[0] = { schema: 'IFC4', applyMutations: true }): string =>
  new TextDecoder().decode(new StepExporter(f.store, f.view).export(options).content);
const body = (text: string) => text.slice(text.indexOf('DATA;'));
const setValues = (store: IfcDataStore, name: string) =>
  Object.fromEntries(extractQuantitiesOnDemand(store, WALL).filter((s) => s.name === name).flatMap((s) => s.quantities.map((q) => [q.name, q.value])));

describe('a set the quantity base revises for a loaded element', () => {
  it('replaces the file\'s set in the export, once, and leaves its other sets alone', async () => {
    const f = await fixture();
    const reopened = await parse(exported(f));
    expect(extractQuantitiesOnDemand(reopened, WALL).filter((s) => s.name === SET)).toHaveLength(1);
    expect(setValues(reopened, SET)).toEqual({ Height: 4, GrossVolume: 6.4 });
    expect(setValues(reopened, 'Qto_Custom')).toEqual({ Fixings: 4 });
  });

  it('is what the view reads, so the tab and the file agree', async () => {
    const f = await fixture();
    const reopened = await parse(exported(f));
    const tab = Object.fromEntries(f.view.getQuantitiesForEntity(WALL).find((s) => s.name === SET)!.quantities.map((q) => [q.name, q.value]));
    expect(setValues(reopened, SET)).toEqual(tab);
  });

  it('a person\'s own edit of a refreshed quantity still wins', async () => {
    const f = await fixture();
    f.view.setQuantity(WALL, SET, 'Height', 5, QuantityType.Length);
    const reopened = await parse(exported(f));
    expect(setValues(reopened, SET)).toEqual({ Height: 5, GrossVolume: 6.4 });
  });

  it('a person\'s deletion of the set still wins', async () => {
    const f = await fixture();
    f.view.deleteQuantitySet(WALL, SET);
    const reopened = await parse(exported(f));
    expect(extractQuantitiesOnDemand(reopened, WALL).map((s) => s.name)).toEqual(['Qto_Custom']);
  });

  it('with nothing revised, the file is written exactly as before', async () => {
    const f = await fixture();
    f.refresh.on = false;
    const off = exported(f);
    const plain = new TextDecoder().decode(new StepExporter(f.store, new MutablePropertyView(null, 'm')).export({ schema: 'IFC4', applyMutations: true }).content);
    expect(body(off)).toBe(body(plain));
    expect(setValues(await parse(off), SET)).toEqual({ Height: 3, GrossVolume: 4.8 });
  });

  it('is left out when the caller excludes quantities', async () => {
    const f = await fixture();
    expect(exported(f, { schema: 'IFC4', applyMutations: true, includeQuantities: false })).not.toContain('IFCQUANTITYLENGTH(\'Height\',$,$,4.');
  });
});
