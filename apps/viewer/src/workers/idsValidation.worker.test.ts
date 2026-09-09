/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS worker must validate the model as the user currently sees it, not
 * as it was written to disk (#3946).
 *
 * The worker re-parses `source`, so an in-memory property correction is
 * invisible to it unless it is handed one. That was the whole reason
 * `useIDS` used to refuse the worker for any model with pending edits, at a
 * cost of O(entities x specifications) on the main thread. Routing such a
 * model to the worker is only correct if the worker APPLIES what it is
 * handed — a request that carries the overlay and an accessor that ignores
 * it would silently validate the stale value and report a failure the user
 * has already fixed.
 *
 * The fixture is built so the two answers differ: `FireRating` is `NONE` in
 * the bytes and the specification requires `F90`, so the same source
 * validates FAIL with no overlay and PASS with one. A fixture that passed
 * either way could not observe this.
 *
 * `self` is stubbed before import because the module registers
 * `self.onmessage` at evaluation time; under Node there is no worker scope.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { contiguousSourceBytes } from '@ifc-lite/parser';
import { parseIDS, type IDSValidationReport } from '@ifc-lite/ids';

import type { PropertyOverlaySnapshot } from '@/lib/ids/property-overlay-snapshot';
import type { IdsWorkerRequest, IdsWorkerResponse } from './idsValidation.worker.js';

const WALL_ID = 100;

/** One IfcWall carrying Pset_WallCommon.FireRating = 'NONE'. */
const IFC = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('3946.ifc','',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
  "#1=IFCPROJECT('0project0000000000000a',$,'P',$,$,$,$,$,#9);",
  '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#9=IFCUNITASSIGNMENT((#2));',
  `#${WALL_ID}=IFCWALL('0wall00000000000000000',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
  "#101=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('NONE'),$);",
  "#102=IFCPROPERTYSET('0pset00000000000000000',$,'Pset_WallCommon',$,(#101));",
  `#103=IFCRELDEFINESBYPROPERTIES('0rel000000000000000000',$,$,$,(#${WALL_ID}),#102);`,
  'ENDSEC;',
  'END-ISO-10303-21;',
  '',
].join('\n');

const IDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info><title>#3946 worker overlay fixture</title></info>
  <specifications>
    <specification name="Walls are F90" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLABEL">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
          <value><simpleValue>F90</simpleValue></value>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

/**
 * Requires only that `FireRating` EXISTS, which the on-disk `NONE` already
 * satisfies. The value-constrained document above cannot observe a DELETE —
 * the wall fails it either way — so a delete case written against it would
 * pass with the overlay wired up or not.
 */
const IDS_XML_EXISTENCE = IDS_XML
  .replace('<value><simpleValue>F90</simpleValue></value>', '')
  .replace('#3946 worker overlay fixture', '#3946 worker overlay fixture (existence only)');

const posted: IdsWorkerResponse[] = [];
let onmessage: ((event: MessageEvent<IdsWorkerRequest>) => Promise<void>) | null = null;

beforeEach(async () => {
  posted.length = 0;
  (globalThis as { self?: unknown }).self = {
    postMessage: (msg: IdsWorkerResponse) => {
      posted.push(msg);
    },
  };
  // Cache-busted so each case gets a module instance whose `self` is the stub
  // installed above rather than a previous case's.
  await import(`./idsValidation.worker.js?t=${Date.now()}${Math.random()}`);
  onmessage = (globalThis as { self?: { onmessage?: typeof onmessage } }).self!.onmessage!;
});

afterEach(() => {
  onmessage = null;
  delete (globalThis as { self?: unknown }).self;
});

async function validate(
  propertyOverlay?: PropertyOverlaySnapshot,
  idsXml: string = IDS_XML
): Promise<IDSValidationReport> {
  const request: IdsWorkerRequest = {
    type: 'validate',
    id: 42,
    source: contiguousSourceBytes(new TextEncoder().encode(IFC)).toTransferable(),
    document: parseIDS(idsXml),
    schemaVersion: 'IFC4',
    modelId: 'M',
    locale: 'en',
    includePassingEntities: true,
    propertyOverlay,
  };
  await onmessage!({ data: request } as MessageEvent<IdsWorkerRequest>);

  const terminal = posted.filter((m) => m.type !== 'progress');
  assert.equal(terminal.length, 1, `expected exactly one terminal reply, got ${JSON.stringify(terminal)}`);
  const reply = terminal[0];
  assert.equal(reply.type, 'complete', reply.type === 'error' ? reply.message : '');
  assert.equal(reply.id, 42, 'the reply must carry the request id');
  return (reply as Extract<IdsWorkerResponse, { type: 'complete' }>).report;
}

describe('IDS worker property overlay (#3946)', () => {
  // The control. Without it, a "passes with the overlay" assertion could not
  // tell a working overlay apart from a fixture that passes regardless.
  it('without an overlay, the on-disk FireRating=NONE fails the F90 requirement', async () => {
    const report = await validate(undefined);
    assert.equal(report.summary.totalEntitiesChecked, 1, 'the wall must be applicable');
    assert.equal(report.summary.failedSpecifications, 1);
    assert.equal(report.summary.totalEntitiesPassed, 0);
  });

  // THE regression: before #3946 the worker built its accessor with
  // `createDataAccessor(store)` and had no way to receive this at all, so a
  // corrected model routed here would have reported the stale failure.
  it('an overlay correcting FireRating to F90 makes the same source PASS', async () => {
    const report = await validate([
      [WALL_ID, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    assert.equal(report.summary.totalEntitiesChecked, 1);
    assert.equal(report.summary.passedSpecifications, 1);
    assert.equal(report.summary.totalEntitiesPassed, 1);
    assert.equal(report.summary.failedSpecifications, 0);
  });

  it('an overlay entry for a DIFFERENT entity does not leak onto the wall', async () => {
    const report = await validate([
      [WALL_ID + 999, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90' }]],
    ]);
    assert.equal(report.summary.failedSpecifications, 1, 'the wall itself was never corrected');
  });

  it('an empty overlay behaves exactly like no overlay at all', async () => {
    const report = await validate([]);
    assert.equal(report.summary.failedSpecifications, 1);
    assert.equal(report.summary.totalEntitiesChecked, 1);
  });

  it('the on-disk model PASSES the existence-only document (control for the delete case)', async () => {
    const report = await validate(undefined, IDS_XML_EXISTENCE);
    assert.equal(report.summary.totalEntitiesChecked, 1);
    assert.equal(report.summary.totalEntitiesPassed, 1);
    assert.equal(report.summary.passedSpecifications, 1);
  });

  // The overlay's other operation, measured where it can actually be seen:
  // against a requirement the bytes already satisfy, so a worker that ignored
  // the overlay would report the PASS above instead.
  it('a DELETE override removes the property, turning that PASS into a failure', async () => {
    const report = await validate(
      [[WALL_ID, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: null, deleted: true }]]],
      IDS_XML_EXISTENCE
    );
    assert.equal(report.summary.totalEntitiesChecked, 1);
    assert.equal(report.summary.totalEntitiesPassed, 0);
    assert.equal(report.summary.failedSpecifications, 1);
  });
});
