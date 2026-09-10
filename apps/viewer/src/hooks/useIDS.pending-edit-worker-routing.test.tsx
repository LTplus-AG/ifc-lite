/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One pending property edit must not drag a whole model's IDS validation
 * onto the main thread (#3946).
 *
 * `runValidation()` used to compute
 * `canUseWorker = !hasPendingPropertyEdits && ...`, so a SINGLE edited
 * property made every subsequent validation of that model run in-process,
 * at a cost of O(entities x specifications) and identical for one edit or
 * a thousand — measured at ~500ms for a 250k-entity model, re-charged on
 * every re-run until the edits were exported or cleared.
 *
 * The fix hands the worker the edits instead, as a `PropertyOverlaySnapshot`
 * costing O(pending edits). These tests pin the ROUTING half of that (does
 * the run reach the worker, and does it carry the overlay);
 * `workers/idsValidation.worker.test.ts` pins the half that matters for
 * correctness — that the worker actually applies what it is handed.
 *
 * Under happy-dom `typeof Worker === 'undefined'`, so a `FakeWorker` is
 * installed on `globalThis`: without it `idsWorkerSupported()` is false and
 * every case here would take the fallback for the wrong reason.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { parseIDS, type IDSValidationReport } from '@ifc-lite/ids';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import type { PropertyOverlaySnapshot } from '@/lib/ids/property-overlay-snapshot';
import { useIDS } from './useIDS.js';

// ─── Fake worker ──────────────────────────────────────────────────────────

interface PostedRequest {
  type: string;
  id: number;
  propertyOverlay?: PropertyOverlaySnapshot;
  [key: string]: unknown;
}

const instances: FakeWorker[] = [];

/**
 * Replies `complete` as soon as it is posted to, so `runValidation` settles
 * without the test having to drive the message pump by hand.
 */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly posted: PostedRequest[] = [];

  constructor() {
    instances.push(this);
  }

  postMessage(message: PostedRequest): void {
    this.posted.push(message);
    queueMicrotask(() => {
      this.onmessage?.({
        data: { type: 'complete', id: message.id, report: WORKER_REPORT },
      });
    });
  }

  terminate(): void {}
}

/** Distinguishable from anything the in-process validator would produce. */
const WORKER_REPORT = {
  summary: {
    totalSpecifications: 1,
    passedSpecifications: 1,
    failedSpecifications: 0,
    totalEntitiesChecked: 1,
    totalEntitiesPassed: 1,
    overallPassRate: 100,
  },
  specificationResults: [],
  document: { specifications: [] },
  timestamp: new Date(0),
  modelInfo: { modelId: 'from-the-worker', schemaVersion: 'IFC4', entityCount: 1 },
} as unknown as IDSValidationReport;

// ─── Fixture ──────────────────────────────────────────────────────────────

const WALL_ID = 1;

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

async function parseWalls(): Promise<IfcDataStore> {
  const body = [
    `#${WALL_ID}=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
    `#2=IFCWALL('0bbbbbbbbbbbbbbbbbbbbb',$,'Wall B',$,$,$,$,$,.STANDARD.);`,
  ].join('\n');
  const bytes = new TextEncoder().encode(ifc4(body));
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

const IDS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <ids:info><ids:title>#3946 routing fixture</ids:title></ids:info>
  <ids:specifications>
    <ids:specification name="Wall with fire rating" ifcVersion="IFC4">
      <ids:applicability minOccurs="0" maxOccurs="unbounded">
        <ids:entity><ids:name><ids:simpleValue>IFCWALL</ids:simpleValue></ids:name></ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property dataType="IFCLABEL">
          <ids:propertySet><ids:simpleValue>Pset_WallCommon</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>FireRating</ids:simpleValue></ids:baseName>
        </ids:property>
      </ids:requirements>
    </ids:specification>
  </ids:specifications>
</ids:ids>`;

function model(id: string, store: IfcDataStore): FederatedModel {
  return {
    id,
    name: `${id}.ifc`,
    ifcDataStore: store,
    geometryResult: { meshes: [] } as unknown as GeometryResult,
    visible: true,
    collapsed: false,
    schemaVersion: store.schemaVersion,
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 2,
  } as unknown as FederatedModel;
}

// ─── Harness ──────────────────────────────────────────────────────────────

type IdsApi = ReturnType<typeof useIDS>;
let api: IdsApi | null = null;
let root: Root | null = null;

function Probe(): null {
  api = useIDS();
  return null;
}

interface SeedOptions {
  /** Register a mutation view carrying one pending property edit. */
  withPendingEdit: boolean;
  /** Label the store IFC5, which is how an IFCX store is recognised. */
  asIfcx?: boolean;
}

async function seed(opts: SeedOptions): Promise<void> {
  const store = await parseWalls();
  if (opts.asIfcx) {
    // `isIfcxDataStore` keys off `schemaVersion` alone, so this exercises the
    // exact predicate `canUseWorker` consults. A real IFCX store additionally
    // carries IFCX JSON in `source` (`buildIfcxDataStore`) — that is what makes
    // a worker re-parse produce an empty store, and what this guard exists to
    // avoid; reproducing it here would only test the parser.
    (store as { schemaVersion: string }).schemaVersion = 'IFC5';
  }

  const mutationViews = new Map<string, MutablePropertyView>();
  if (opts.withPendingEdit) {
    const view = new MutablePropertyView(null, 'M');
    view.setProperty(WALL_ID, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    assert.equal(view.hasPendingChanges(), true, 'fixture must actually carry an edit');
    mutationViews.set('M', view);
  }

  useViewerStore.setState({
    models: new Map<string, FederatedModel>([['M', model('M', store)]]),
    activeModelId: 'M',
    mutationViews,
    idsDocument: parseIDS(IDS_XML),
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
  instances.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(async () => {
  delete (globalThis as { Worker?: unknown }).Worker;
  useViewerStore.setState({ mutationViews: new Map(), models: new Map(), activeModelId: null });
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('useIDS worker routing with pending property edits (#3946)', () => {
  it('a model with NO pending edits reaches the worker (control: the fixture can route)', async () => {
    await seed({ withPendingEdit: false });

    const run: { report: IDSValidationReport | null } = { report: null };
    await act(async () => {
      run.report = await api!.runValidation('M');
    });

    assert.equal(instances.length, 1, 'the unedited path has always used the worker');
    assert.equal(
      run.report?.modelInfo.modelId,
      'from-the-worker',
      'the report must be the one the worker returned, not an in-process run'
    );
    assert.equal(
      instances[0].posted[0].propertyOverlay,
      undefined,
      'no edits means no overlay — the byte-identical pre-#3946 payload'
    );
  });

  // THE regression. Before #3946 this asserted zero worker instances, because
  // one edit set `canUseWorker` to false and the whole model was validated on
  // the main thread.
  it('a model with ONE pending property edit still reaches the worker', async () => {
    await seed({ withPendingEdit: true });

    const run: { report: IDSValidationReport | null } = { report: null };
    await act(async () => {
      run.report = await api!.runValidation('M');
    });

    assert.equal(
      instances.length,
      1,
      'one edited property must not move the whole validation onto the main thread'
    );
    assert.equal(run.report?.modelInfo.modelId, 'from-the-worker');
  });

  it('the edit crosses to the worker as an overlay entry, so it is not silently dropped', async () => {
    await seed({ withPendingEdit: true });
    await act(async () => {
      await api!.runValidation('M');
    });

    const overlay = instances[0].posted[0].propertyOverlay;
    assert.ok(overlay, 'routing to the worker without the overlay would validate the STALE value');
    assert.deepEqual(overlay, [
      [WALL_ID, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90', dataType: undefined }]],
    ]);
  });

  it('the overlay is O(edits): an untouched entity contributes no entry', async () => {
    await seed({ withPendingEdit: true });
    await act(async () => {
      await api!.runValidation('M');
    });

    const overlay = instances[0].posted[0].propertyOverlay!;
    assert.equal(overlay.length, 1, 'the model has two walls; only the edited one may appear');
    assert.equal(
      overlay.some(([expressId]) => expressId === 2),
      false
    );
  });

  it('the overlay survives structured clone, which is how it actually reaches the worker', async () => {
    await seed({ withPendingEdit: true });
    await act(async () => {
      await api!.runValidation('M');
    });

    const overlay = instances[0].posted[0].propertyOverlay!;
    // postMessage throws DataCloneError on a non-clonable payload, and the
    // client turns that into a rejected run — a `MutablePropertyView` (class,
    // Maps of class instances, injected extractor FUNCTIONS) would do exactly
    // that. This asserts the snapshot is plain data instead.
    assert.deepEqual(structuredClone(overlay), overlay);
  });

  // The edit-fork was accidentally protecting IFCX. An IFCX store's `source` is
  // the IFCX JSON file, so the worker's `parseColumnar` would parse JSON as
  // STEP and validate an empty store. Dropping the fork without this guard
  // would turn a correct main-thread validation into a silently empty one.
  it('an IFCX (IFC5) model with a pending edit still validates in-process', async () => {
    await seed({ withPendingEdit: true, asIfcx: true });

    const run: { report: IDSValidationReport | null } = { report: null };
    await act(async () => {
      run.report = await api!.runValidation('M');
    });

    assert.equal(instances.length, 0, 'the worker cannot re-parse IFCX JSON as STEP');
    assert.notEqual(
      run.report?.modelInfo.modelId,
      'from-the-worker',
      'the report must come from the in-process validator'
    );
  });

  it('an IFCX model with NO pending edits also stays in-process', async () => {
    await seed({ withPendingEdit: false, asIfcx: true });
    await act(async () => {
      await api!.runValidation('M');
    });
    assert.equal(instances.length, 0);
  });
});
