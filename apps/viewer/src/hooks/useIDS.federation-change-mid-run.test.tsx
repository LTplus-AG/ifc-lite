/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A1 (implicit-state audit): an IDS run must not publish for a model set
 * that changed while it ran.
 *
 * `runValidation()` reads the federation once, then awaits the engine. The
 * epoch guard only moved on run/cancel/definition change, so a teardown that
 * landed mid-run — `removeModel` / `clearAllModels` (which call
 * `clearIdsValidationReport()`), or the session reset of "open a new file"
 * (which sets `idsLoading: false`) — reset the flags and nothing else. The
 * run kept writing `idsProgress` under `idsLoading: false`, then published a
 * report whose snapshot named the removed model and recoloured its ids.
 *
 * The removal is issued synchronously right after the run starts, so it
 * lands before the run's first `await` resumes — the engine is still
 * pending, deterministically, without mocking it.
 */

import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { useIDS } from './useIDS.js';

function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** `n` distinct IfcWalls with no properties, so every one fails the "has
 *  AcousticRating" requirement below — the validator must actually check
 *  each one, giving the yielder real work to do. */
function wallsBody(n: number, tag: string): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const guid = `${tag}${String(i).padStart(21, '0')}`.slice(0, 22);
    lines.push(`#${i + 1}=IFCWALL('${guid}',$,'Wall ${tag}${i}',$,$,$,$,$,.STANDARD.);`);
  }
  return lines.join('\n');
}

async function parse(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

const IDS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <ids:info>
    <ids:title>useIDS federation-change fixture</ids:title>
  </ids:info>
  <ids:specifications>
    <ids:specification name="Wall with acoustic rating" ifcVersion="IFC4">
      <ids:applicability minOccurs="0" maxOccurs="unbounded">
        <ids:entity>
          <ids:name><ids:simpleValue>IFCWALL</ids:simpleValue></ids:name>
        </ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property dataType="IFCLABEL">
          <ids:propertySet><ids:simpleValue>Pset_WallCommon</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>AcousticRating</ids:simpleValue></ids:baseName>
        </ids:property>
      </ids:requirements>
    </ids:specification>
  </ids:specifications>
</ids:ids>`;

const SLOW_COUNT = 6000;

function model(id: string, store: IfcDataStore, idOffset = 0): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: { meshes: [] } as unknown as GeometryResult,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: SLOW_COUNT,
  };
}

type IdsApi = ReturnType<typeof useIDS>;
let api: IdsApi | null = null;
function Probe() { api = useIDS(); return null; }
let root: Root | null = null;

async function seed(): Promise<void> {
  const storeA = await parse(wallsBody(SLOW_COUNT, 'sA'));
  const storeB = await parse(wallsBody(8, 'sB'));
  useViewerStore.setState({
    models: new Map<string, FederatedModel>([['A', model('A', storeA)], ['B', model('B', storeB, 1_000_000)]]),
    activeModelId: 'A', idsDocument: parseIDS(IDS_XML),
    idsValidationReport: null, currentValidationReport: null, idsError: null, idsLoading: false, idsProgress: null,
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(api, 'useIDS must be mounted');
}

beforeEach(() => { api = null; useActivityJournal.setState({ jobs: [] }); });
afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

/** Start a run and return it WITHOUT letting any of its awaits resume. */
function startRun(): Promise<unknown> {
  let pending: Promise<unknown> | undefined;
  act(() => { pending = api!.runValidation('A'); });
  assert.equal(useViewerStore.getState().idsLoading, true, 'setup: the run is in flight');
  return pending!;
}

async function assertRunDiscarded(pending: Promise<unknown>): Promise<void> {
  // The teardown itself must already leave a coherent, idle panel.
  assert.equal(useViewerStore.getState().idsLoading, false);
  assert.equal(useViewerStore.getState().idsProgress, null);
  let resolved: unknown;
  await act(async () => { resolved = await pending; });
  const s = useViewerStore.getState();
  assert.equal(resolved === null, true, 'the invalidated call resolves null, not the report it computed');
  assert.equal(s.idsValidationReport, null, 'no report for a model set that no longer exists');
  assert.equal(s.currentValidationReport, null);
  assert.equal(s.idsFailedEntityIds.size, 0, 'no entity ids recoloured');
  assert.equal(s.idsLoading, false);
  assert.equal(s.idsProgress, null, 'no progress written after the run was invalidated');
  assert.deepEqual(useActivityJournal.getState().jobs.map((job) => job.outcome), ['cancelled']);
}

describe('useIDS — federation changes mid-run (A1)', () => {
  it('A1: removing a federated model mid-run discards the run', async () => {
    await seed();
    const pending = startRun();
    act(() => { useViewerStore.getState().removeModel('B'); });
    await assertRunDiscarded(pending);
  });

  it('A1: clearing every model mid-run discards the run', async () => {
    await seed();
    const pending = startRun();
    act(() => { useViewerStore.getState().clearAllModels(); });
    await assertRunDiscarded(pending);
  });

  it('A1: a session reset ("open a new file") mid-run discards the run, not just the loading flag', async () => {
    await seed();
    const pending = startRun();
    act(() => { useViewerStore.getState().resetViewerState(); });
    await assertRunDiscarded(pending);
  });

  it('A1: a model whose entity table is replaced mid-run (collab peer edit) discards the run', async () => {
    await seed();
    const reparsed = await parse(wallsBody(8, 'sB'));
    const pending = startRun();
    // No teardown and no generation bump: only the federation identity sees it.
    act(() => {
      const models = new Map(useViewerStore.getState().models);
      models.set('B', { ...models.get('B')!, ifcDataStore: reparsed });
      useViewerStore.setState({ models });
    });
    await assertRunDiscarded(pending);
  });

  it('A1: a model ADDED mid-run does not discard the run (the clash rule)', async () => {
    await seed();
    const pending = startRun();
    const storeC = await parse(wallsBody(4, 'sC'));
    act(() => { useViewerStore.getState().addModel(model('C', storeC, 2_000_000)); });
    let resolved: unknown;
    await act(async () => { resolved = await pending; });
    assert.equal(resolved !== null, true, 'an added file must not throw the run away');
    assert.equal(useViewerStore.getState().idsValidationReport?.summary.totalEntitiesFailed, SLOW_COUNT);
    assert.equal(useViewerStore.getState().idsLoading, false);
  });
});
