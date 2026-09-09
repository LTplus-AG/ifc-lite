/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End-to-end reproduction of #4328: filter the hierarchy panel's Class tab
 * to `IfcWallStandardCase`, export "Visible Only", and assert the STEP
 * output contains only walls (plus the structural scaffolding a valid IFC
 * file always needs) — not the door the class filter excluded.
 *
 * Goes through the SAME two steps `ExportDialog.tsx` does: resolve local
 * hidden/isolated ids via `resolveExportVisibility` (the shared resolver),
 * then feed them into `StepExporter` exactly as `handleExport`'s STEP branch
 * does (`visibleOnly`, `hiddenEntityIds`, `isolatedEntityIds`). A regression
 * in either the resolver or the wiring between it and the exporter fails
 * this test the way the reporter's export failed.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { asSourceBytes, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { resolveExportVisibility } from './exportVisibility.js';
import { useViewerStore } from './index.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

type MockEntityRef = {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
};

/** Same synthetic-store shape `visible-only-dangling-refs.test.ts` uses. */
function buildParsedStore(entries: Array<[number, string, string]>): IfcDataStore {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const byId = new Map<number, MockEntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;

  for (const [id, type, text] of entries) {
    const encoded = encoder.encode(text);
    const upper = type.toUpperCase();
    byId.set(id, { expressId: id, type: upper, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(id);
    parts.push(encoded);
    offset += encoded.byteLength;
  }

  const source = new Uint8Array(offset);
  let position = 0;
  for (const part of parts) {
    source.set(part, position);
    position += part.byteLength;
  }

  return {
    fileSize: offset,
    schemaVersion: 'IFC4',
    entityCount: entries.length,
    parseTime: 0,
    source: asSourceBytes(source),
    entityIndex: { byId, byType },
  } as unknown as IfcDataStore;
}

const PROJECT = "#1=IFCPROJECT('0proj0000000000000000',$,'P',$,$,$,$,$,$);\n";
const STOREY = "#2=IFCBUILDINGSTOREY('0stor0000000000000000',$,'S',$,$,$,$,$,$,0.);\n";
const WALL = "#3=IFCWALLSTANDARDCASE('0wall0000000000000000',$,'Wall',$,$,$,$,$);\n";
const DOOR = "#4=IFCDOOR('0door0000000000000000',$,'Door',$,$,$,$,$,$,$,$);\n";

function buildFourEntityStore(): IfcDataStore {
  return buildParsedStore([
    [1, 'IFCPROJECT', PROJECT],
    [2, 'IFCBUILDINGSTOREY', STOREY],
    [3, 'IFCWALLSTANDARDCASE', WALL],
    [4, 'IFCDOOR', DOOR],
  ]);
}

describe('#4328: Class tab filter reaching "Export Visible Only" (STEP)', () => {
  beforeEach(() => {
    useViewerStore.getState().resetViewerState();
  });

  it('classFilter=IfcWallStandardCase -> STEP output has the wall and structural scaffolding, not the door', () => {
    const dataStore = buildFourEntityStore();
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: dataStore,
      hiddenEntities: new Set(),
      isolatedEntities: null,
      classFilter: { ids: new Set([3]), label: 'IfcWallStandardCase' },
    });

    const { hiddenLocalIds, isolatedLocalIds } = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
    const content = decode(
      new StepExporter(dataStore).export({
        schema: 'IFC4',
        visibleOnly: true,
        hiddenEntityIds: hiddenLocalIds,
        isolatedEntityIds: isolatedLocalIds,
      }).content,
    );

    // Structural scaffolding: always retained, deliberately, regardless of
    // the class filter — a STEP file missing IfcProject/spatial structure
    // is invalid.
    assert.ok(content.includes('#1=IFCPROJECT'), 'IfcProject must survive visibleOnly');
    assert.ok(content.includes('#2=IFCBUILDINGSTOREY'), 'IfcBuildingStorey must survive visibleOnly');
    // The filtered class survives...
    assert.ok(content.includes('#3=IFCWALLSTANDARDCASE'), 'the class-filtered wall must be exported');
    // ...and the excluded class does not (the #4328 bug: this used to fail).
    assert.ok(!content.includes('IFCDOOR'), 'the door excluded by the class filter must NOT be exported');
  });

  it('no filter active -> STEP output is the full model, unchanged (both directions)', () => {
    const dataStore = buildFourEntityStore();
    useViewerStore.setState({
      models: new Map(),
      ifcDataStore: dataStore,
      hiddenEntities: new Set(),
      isolatedEntities: null,
      classFilter: null,
    });

    const { hiddenLocalIds, isolatedLocalIds } = resolveExportVisibility(useViewerStore.getState(), '__legacy__');
    assert.strictEqual(isolatedLocalIds, null);

    const content = decode(
      new StepExporter(dataStore).export({
        schema: 'IFC4',
        visibleOnly: true,
        hiddenEntityIds: hiddenLocalIds,
        isolatedEntityIds: isolatedLocalIds,
      }).content,
    );

    assert.ok(content.includes('#1=IFCPROJECT'));
    assert.ok(content.includes('#2=IFCBUILDINGSTOREY'));
    assert.ok(content.includes('#3=IFCWALLSTANDARDCASE'), 'no filter must not drop the wall');
    assert.ok(content.includes('#4=IFCDOOR'), 'no filter must not drop the door either');
  });
});
