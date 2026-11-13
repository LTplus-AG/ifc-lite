/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A shared room's store is tabular — the room is reconstructed from IFCX —
 * and a STEP export of it reads the portable STEP source registered against
 * that store, not the tables. `exportModelStep` and `roomMergeInput` both
 * reach for it through `roomStepExportSource`, and main exported such a room
 * on both paths.
 *
 * The `.3dm` work added a tabular refusal to the export gate
 * (`stepSkipReason`) which, asked for the source kind alone, refused every
 * shared room as well: the single export's button went dead and the merged
 * export dropped the model before `roomMergeInput` was ever called. These two
 * cases are the regression, so they are asserted through the dialog rather
 * than against the predicate — that is the level both this branch and main
 * can answer at.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { render, cleanup, click, waitFor, press, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { tabularFixtureStore, PROXY_A, PROXY_B, WALL } from '@/test/tabular-store-fixture';
import { registerRoomSymbolicSource, type RoomSymbolicSource } from '@/lib/collab/room-symbolic-source';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { ExportDialog } from './ExportDialog';

/**
 * The portable STEP source a room slot keeps: real records, with one root per
 * root the reconstructed room has. Its GlobalIds are the tabular fixture's,
 * because that is what matches a room back to its source.
 */
const ROOM_STEP_SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('room-source.ifc','2020-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0aBcDeFgHiJkLmNoPqRs00',$,'Room Source',$,$,$,$,$,$);
#11=IFCBUILDINGELEMENTPROXY('0aBcDeFgHiJkLmNoPqRs01',$,'Object A',$,$,$,$,$,$);
#12=IFCBUILDINGELEMENTPROXY('0aBcDeFgHiJkLmNoPqRs02',$,'Object B',$,$,$,$,$,$);
#13=IFCWALL('0aBcDeFgHiJkLmNoPqRs03',$,'Wall C',$,$,$,$,'TAG-C');
ENDSEC;
END-ISO-10303-21;
`;

/** Source express ids of the three roots above, in room-id order. */
const SOURCE_ROOTS = [11, 12, 13] as const;
const ROOM_ROOTS = [PROXY_A, PROXY_B, WALL] as const;

async function parseRoomStepSource(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ROOM_STEP_SOURCE);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

/**
 * A room slot as the viewer holds one: the reconstructed tabular store the
 * federation shows, with its portable STEP source registered against it the
 * way `attachRoomStepSource` registers one. Every room root is covered, so
 * `canExportRoomAsStep` accepts it.
 */
async function sharedRoomModel(id: string): Promise<FederatedModel> {
  const roomStore = tabularFixtureStore();
  const portable = await parseRoomStepSource();
  const source: RoomSymbolicSource = {
    dataStore: portable,
    source: portable.source,
    seededIds: new Set(SOURCE_ROOTS),
    ownerIds: new Map(SOURCE_ROOTS.map((sourceId, at) => [sourceId, ROOM_ROOTS[at]])),
    placements: new Map(),
    baselines: new Map(),
    structuredPsets: new Map(),
    structuredQuantities: new Map(),
    structuredAttributes: new Map(),
  };
  registerRoomSymbolicSource(roomStore, source);
  return { ...fixtureModel(id), schemaVersion: 'IFC4' as const, ifcDataStore: roomStore };
}

const shellText = () => document.querySelector('[data-export-dialog-shell]')?.textContent ?? '';
const openDialog = (ui: HTMLElement, label: string) =>
  click([...ui.querySelectorAll('button')].find(node => node.textContent?.includes(label))!);
const exportButton = () =>
  [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Export') as HTMLButtonElement;

/** Switch the scope select to the merged option. */
async function chooseMerged(): Promise<void> {
  const scope = [...document.querySelectorAll('[role="combobox"]')].find(node => node.textContent?.includes('Single Model'));
  assert.ok(scope, 'the scope selector is offered for a federation');
  press(scope, 'ArrowDown'); await advance(10);
  const merged = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('Merged (All Models)'));
  assert.ok(merged);
  click(merged); await advance(10);
}

afterEach(() => { cleanup(); clearDownloads(); });

describe('a STEP export writes a shared room from its portable source', () => {
  it('exports the selected room as IFC instead of refusing it for having no records', async () => {
    const room = await sharedRoomModel('shared-room');
    const house = { ...fixtureModel('house.ifc', { idOffset: 1_000_000 }), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(room, house), dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openDialog(ui, 'Export IFC');
    await advance(10);

    assert.equal(exportButton().disabled, false, 'the room carries STEP records, so the export is offered');
    assert.doesNotMatch(shellText(), /no IFC records to write from/, 'nothing is refused, so nothing says it is');

    click(exportButton());
    await waitFor(() => downloadedNames().length === 1, 'the room was not exported as STEP');
    assert.match(downloadedNames()[0], /^shared-room.*_export\.ifc$/);
  });

  it('keeps the room in a merged export, and does not name it as left out', async () => {
    const room = await sharedRoomModel('shared-room');
    const house = { ...fixtureModel('house.ifc', { idOffset: 1_000_000 }), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(room, house), dirtyModels: new Set() });
    const ui = render(<ExportDialog surface="ribbon" />);
    openDialog(ui, 'Export IFC');
    await chooseMerged();

    assert.doesNotMatch(shellText(), /Left out of the merged file/, 'the room is merged, so the dialog claims no skip');

    click(exportButton());
    await waitFor(() => downloadedNames().length === 1, 'merged IFC export did not download');
    assert.match(shellText(), /Merged 2 models/, 'both the room and the IFC model are in the merged file');
    assert.doesNotMatch(shellText(), /Left out of the merged file/);
  });
});
