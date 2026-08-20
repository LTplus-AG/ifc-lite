/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PR #2837 review (coderabbit) on top of the #2802 supersession sweep:
 *
 * 1. `clearIDS()` / `clearValidation()` bump `validationEpochRef` so an
 *    in-flight `runValidation()` sees `stillWantedValidation(myEpoch)` go
 *    false and — BY DESIGN — skips its own `finally` reset of `idsLoading`
 *    (see the comment above `stillWantedValidation` in useIDS.ts: an older
 *    call's finally must not flip busy state off underneath a newer one).
 *    But `clearIdsDocument()` / `clearIdsValidationReport()` (idsSlice.ts),
 *    the only OTHER writers of `idsLoading`, never reset it either. Nothing
 *    was left to turn it off: a clear that lands while a validation is in
 *    flight left `idsLoading` (and `idsProgress`) stuck forever, showing a
 *    spinner that never resolves.
 *
 * 2. The superseded run itself still RESOLVED with its (unpublished) report
 *    instead of `null` — inconsistent with the catch path, which correctly
 *    resolves `null` on supersession. `runValidation` is public API
 *    (`UseIDSResult.runValidation`); a caller that awaits a superseded call
 *    got a report the store deliberately never published and could act on
 *    stale data.
 *
 * Reuses the slow/fast fixture shape from
 * useIDS.concurrent-run-supersession.test.tsx (a wall count large enough
 * that the validator's internal yielder actually returns to the event loop,
 * so a `clearIDS()` issued right after `runValidation()` genuinely lands
 * mid-run instead of after it).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS } from '@ifc-lite/ids';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
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
    <ids:title>useIDS clear-during-run fixture</ids:title>
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

function model(id: string, store: IfcDataStore): FederatedModel {
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
    idOffset: 0,
    maxExpressId: SLOW_COUNT,
  };
}

type IdsApi = ReturnType<typeof useIDS>;
let api: IdsApi | null = null;

function Probe(): null {
  api = useIDS();
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const slowStore = await parse(wallsBody(SLOW_COUNT, 'sA'));
  const models = new Map<string, FederatedModel>([['Slow', model('Slow', slowStore)]]);
  const idsDoc = parseIDS(IDS_XML);
  useViewerStore.setState({
    models,
    activeModelId: 'Slow',
    idsDocument: idsDoc,
    idsValidationReport: null,
    idsError: null,
    idsLoading: false,
    idsProgress: null,
  });
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(api, 'useIDS must be mounted');
}

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

describe('useIDS — clearing during an in-flight runValidation (PR #2837 review)', () => {
  it('clearIDS() does not leave idsLoading stuck once the superseded run lands', async () => {
    await seed();

    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = api!.runValidation('Slow');
    });
    assert.equal(useViewerStore.getState().idsLoading, true, 'setup sanity: the run must be marked loading');

    await act(async () => {
      api!.clearIDS();
    });
    // The clear itself must already show "not loading" — a user who clears
    // must see the UI stop showing a spinner immediately, not wait for the
    // superseded run to land.
    assert.equal(
      useViewerStore.getState().idsLoading,
      false,
      'clearIDS() must reset idsLoading itself, not rely on the (now-superseded) in-flight run to do it',
    );

    await act(async () => {
      await pending;
    });

    const s = useViewerStore.getState();
    assert.equal(
      s.idsLoading,
      false,
      'idsLoading must still read false after the superseded run resolves — it must not have been left ' +
        'stuck on because the run\'s own finally correctly declined to touch it post-clear',
    );
    assert.equal(s.idsDocument, null, 'the clear must still have taken effect');
  });

  it('the superseded runValidation() call itself resolves null, not the discarded report', async () => {
    await seed();

    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = api!.runValidation('Slow');
    });

    await act(async () => {
      api!.clearIDS();
    });

    let resolved: unknown;
    await act(async () => {
      resolved = await pending;
    });

    // Compare a boolean, not `resolved` itself: on failure `resolved` is the
    // full (thousands-of-entities) validation report, and node:assert's
    // failure-path diff of that object is expensive enough to be worth
    // avoiding here.
    assert.equal(
      resolved === null,
      true,
      'a superseded runValidation() call must resolve null, matching what it actually published (nothing) — ' +
        'not the report it computed but discarded',
    );
  });
});
