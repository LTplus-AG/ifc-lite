/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the USD export source gate. The mutation-vs-raw routing is
 * `resolveEnergyExportMutationSource` (covered in `energy-export-source.test.ts`) and
 * the end-to-end export + WASM disposal is `UsdExportDialog.test.tsx`; this
 * suite locks which models the USD exporter is offered — in particular that
 * `.ifcx` (USD-flavored JSON, a separate exporter) is excluded so it can never
 * be fed to the STEP-byte `exportUsd` and produce a silent empty stage.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types.js';
import { isUsdExportableModel, resolveUsdExportBytes, type UsdExportModel } from './usd-export-source.js';

/** Trivial but valid IFC4 file — just enough for `IfcParser.parseColumnar`. */
const MINIMAL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function parsedDataStore(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(MINIMAL_IFC).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

function model(name: string | null): FederatedModel {
  return {
    id: 'm',
    name: name ?? 'unnamed',
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: name ? new File([new Uint8Array([1])], name) : undefined,
    idOffset: 0,
    maxExpressId: 0,
  };
}

describe('isUsdExportableModel', () => {
  it('accepts STEP-backed IFC sources (.ifc, .ifczip), case-insensitively', () => {
    assert.equal(isUsdExportableModel(model('building.ifc')), true);
    assert.equal(isUsdExportableModel(model('site.IFC')), true);
    assert.equal(isUsdExportableModel(model('archive.ifczip')), true);
    assert.equal(isUsdExportableModel(model('archive.IfcZip')), true);
  });

  it('excludes .ifcx (USD-flavored JSON — a separate exporter, not a STEP source)', () => {
    assert.equal(isUsdExportableModel(model('model.ifcx')), false);
  });

  it('excludes models with no source file (cache-restored) and non-IFC sources', () => {
    assert.equal(isUsdExportableModel(model(null)), false);
    assert.equal(isUsdExportableModel(model('scan.glb')), false);
    assert.equal(isUsdExportableModel(model('cloud.las')), false);
  });
});

/**
 * `IfcDataStore.source` is a MANDATORY accessor (#2183, #2345): even the
 * "no source" state is an object (`EMPTY_SOURCE_BYTES`), never
 * null/undefined, so a plain `model.ifcDataStore?.source` truthiness check
 * is always true and can never fall through to step 3 (raw `sourceFile`
 * bytes). Only `byteLength` distinguishes "has usable bytes" from "does
 * not" — this suite locks that step 3 still fires for a genuinely
 * source-less store (server-parsed, synthetic) instead of silently handing
 * `exportUsd` zero bytes, which produces an empty USD stage with no error.
 */
describe('resolveUsdExportBytes', () => {
  const RAW_FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
  const noMutationView = () => null;

  function usdModel(ifcDataStore: IfcDataStore | null): UsdExportModel {
    return {
      id: 'm',
      name: 'building',
      sourceFile: new File([RAW_FILE_BYTES], 'building.ifc'),
      ifcDataStore,
      schemaVersion: 'IFC4',
    };
  }

  it('falls back to the raw sourceFile bytes when ifcDataStore is null', async () => {
    const bytes = await resolveUsdExportBytes(usdModel(null), noMutationView);
    assert.deepEqual(bytes, RAW_FILE_BYTES);
  });

  it('falls back to the raw sourceFile bytes when the store has an EMPTY source (server-parsed / synthetic)', async () => {
    const parsed = await parsedDataStore();
    const store: IfcDataStore = { ...parsed, source: EMPTY_SOURCE_BYTES };
    const bytes = await resolveUsdExportBytes(usdModel(store), noMutationView);
    // RED (pre-fix): materialize()'d EMPTY_SOURCE_BYTES yields a zero-length
    // array here instead — a silent empty USD stage, not an error.
    assert.deepEqual(bytes, RAW_FILE_BYTES);
  });

  it('still prefers the parsed store bytes when the store DOES have real source (bounding control)', async () => {
    const store = await parsedDataStore();
    const bytes = await resolveUsdExportBytes(usdModel(store), noMutationView);
    assert.deepEqual(bytes, store.source.materialize());
    assert.ok(bytes.byteLength > 0);
  });
});
