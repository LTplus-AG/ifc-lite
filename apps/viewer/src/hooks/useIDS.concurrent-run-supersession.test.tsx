/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Supersession race on the IDS validation path (issue #2802 sweep).
 *
 * `runValidation()` (`useIDS.ts`) has NO supersession guard of ANY kind - not
 * even a federation-identity check like `useClash`'s `publishClashResult`. It
 * resolves the validation target once at the top of the call, awaits the
 * (potentially long) validation, and then writes `setIdsValidationReport(...)`
 * unconditionally. Nothing checks whether a NEWER `runValidation()` call
 * (a different target model, or a re-run against the same one) has started
 * in the meantime.
 *
 * This reproduces it directly: `runValidation('Slow')` (many entities, so the
 * validator's internal yielder - `createYielder`/`maybeYield` in
 * `packages/ids/src/validation/validator.ts`, default `yieldEveryMs: 40` -
 * actually returns to the event loop several times) is started first, and
 * `runValidation('Fast')` (two entities, resolves without ever needing a
 * second yield) is started immediately after, with no `await` between the
 * two calls. `Fast` legitimately finishes first. `Slow` finishes after and
 * today overwrites the newer call's report with the older, superseded one.
 *
 * The two runs are distinguished by `report.modelInfo.modelId`.
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

// ─── Fixture ──────────────────────────────────────────────────────────────

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

/** `n` distinct IfcWalls with no properties, so every one fails the
 *  "has AcousticRating" requirement below - the validator must actually
 *  check each one, giving the yielder real work to do. */
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
    <ids:title>useIDS supersession fixture</ids:title>
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
const FAST_COUNT = 2;

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

// ─── Harness ────────────────────────────────────────────────────────────

type IdsApi = ReturnType<typeof useIDS>;
let api: IdsApi | null = null;

function Probe(): null {
  api = useIDS();
  return null;
}

let root: Root | null = null;

async function seed(): Promise<void> {
  const [slowStore, fastStore] = await Promise.all([
    parse(wallsBody(SLOW_COUNT, 'sA')),
    parse(wallsBody(FAST_COUNT, 'fA')),
  ]);
  const models = new Map<string, FederatedModel>([
    ['Slow', model('Slow', slowStore)],
    ['Fast', model('Fast', fastStore)],
  ]);
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

describe('useIDS - concurrent-run supersession (#2802)', () => {
  it('a later runValidation() for a different model that finishes first must not be overwritten by an earlier, slower one', async () => {
    await seed();

    let slowPending: Promise<unknown> | undefined;
    let fastPending: Promise<unknown> | undefined;
    await act(async () => {
      slowPending = api!.runValidation('Slow');
      fastPending = api!.runValidation('Fast');
    });

    await act(async () => {
      await fastPending;
    });
    const afterFast = useViewerStore.getState().idsValidationReport;
    assert.ok(afterFast, 'the fast run must have published');
    assert.equal(afterFast!.modelInfo.modelId, 'Fast');

    await act(async () => {
      await slowPending;
    });

    const s = useViewerStore.getState();
    assert.ok(s.idsValidationReport, 'a report must still be present');
    assert.equal(
      s.idsValidationReport!.modelInfo.modelId,
      'Fast',
      'runValidation("Fast") was started SECOND (while the Slow validation was already in flight) and it ' +
        'finished FIRST - it is the one the user is waiting on. The earlier, slower Slow validation finishing ' +
        'later must not overwrite it just because it lands last.',
    );
  });
});
